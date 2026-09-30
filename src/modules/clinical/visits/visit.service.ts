/* eslint-disable @typescript-eslint/no-explicit-any */
import { Request } from "express";
import mongoose, { Types } from "mongoose";
import AppError from "../../../errors/AppError";
import { publish } from "../../../events/bus";
import { assertCanAccess } from "../../../middlewares/authorize";
import { nextCode } from "../../../models/counter.model";
import { allergyMatches, buildInstructions, duplicateGenerics, MealTiming } from "../../../shared/clinical-rules";
import { emitToRoom } from "../../../sockets";
import { ageOn, todayInDhaka } from "../../../utils/date";
import { recordAudit } from "../../audit/audit.service";
import { notifyAppointmentChanged, publishAppointmentStatus } from "../../hospital/appointment/appointment.events";
import { AppointmentDocument, AppointmentModel } from "../../hospital/appointment/appointment.model";
import {
  appointmentService,
  applyTransition,
  loadAppointment,
  toAppointmentView,
} from "../../hospital/appointment/appointment.service";
import { PatientModel } from "../../patients/patient.model";
import { maskName, registerDocumentResolver } from "../../../documents/verify.route";
import { assertEmrAccess, doctorIdOf } from "../emr-access";
import { announceNewOrder, createOrderForVisit } from "../lab/lab.service";
import type { LabOrderDocument } from "../lab/labOrder.model";
import { patientVitalsHistory, toVitalsView } from "../vitals/vitals.service";
import { VitalsModel } from "../vitals/vitals.model";
import { PrescriptionItem, PrescriptionTemplateModel, VisitDocument, VisitModel } from "./visit.model";

/**
 * VISIT SERVICE — the medical record of a consultation.
 *
 * Rules enforced here (not only in the UI):
 *  - only the patient's doctor for that appointment writes the visit;
 *  - a closed visit never changes: corrections are addenda (who / when / what / why);
 *  - every read of a record is a VIEW audit entry; create / update / close / addendum too;
 *  - a medicine that matches a recorded allergy needs an explicit override with a reason.
 */

// ------------------------------------------------------------------ input types

export type ItemInput = Omit<PrescriptionItem, "medicine" | "durationDays"> & {
  medicineId?: string | null;
  durationDays?: number | "continue" | null;
};

export type VisitPatch = Partial<{
  chiefComplaints: string[];
  historyOfPresentIllness: string;
  pastHistory: string;
  examination: string;
  provisionalDiagnosis: string;
  finalDiagnosis: string;
  investigations: { labTestId?: string | null; name: string; note?: string }[];
  prescription: ItemInput[];
  adviceEn: string;
  adviceBn: string;
  followUp: { date?: string | null; note?: string } | null;
  referral: { to?: string; reason?: string } | null;
  aiSummaryUsed: boolean;
  allergyOverrides: { medicine: string; allergy: string; reason: string }[];
}>;

const EDITABLE = [
  "chiefComplaints",
  "historyOfPresentIllness",
  "pastHistory",
  "examination",
  "provisionalDiagnosis",
  "finalDiagnosis",
  "investigations",
  "prescription",
  "adviceEn",
  "adviceBn",
  "followUp",
  "referral",
  "aiSummaryUsed",
] as const;

// ------------------------------------------------------------------ serialisation

const PATIENT_FIELDS = "name nameBn patientCode gender dateOfBirth bloodGroup allergies chronicConditions";
const DOCTOR_FIELDS = "title name nameBn degrees specialization roomNo";

const toItemView = (i: any) => ({
  medicineId: i.medicine ? String(i.medicine) : null,
  brandName: i.brandName,
  genericName: i.genericName ?? "",
  strength: i.strength ?? "",
  form: i.form ?? "",
  dosePattern: i.dosePattern,
  timing: i.timing ?? null,
  durationDays: i.continued ? "continue" : (i.durationDays ?? null),
  route: i.route ?? "oral",
  instructionsEn: i.instructionsEn ?? "",
  instructionsBn: i.instructionsBn ?? "",
  note: i.note ?? "",
});

type ItemView = {
  medicineId: string | null;
  brandName: string;
  genericName: string;
  strength: string;
  form: string;
  dosePattern: string;
  timing: MealTiming | null;
  durationDays: number | "continue" | null;
  route: string;
  instructionsEn: string;
  instructionsBn: string;
  note: string;
};

/** The record's clinical content (what the audit log keeps as before/after) */
const contentOf = (v: any) => ({
  chiefComplaints: [...(v.chiefComplaints ?? [])],
  historyOfPresentIllness: v.historyOfPresentIllness ?? "",
  pastHistory: v.pastHistory ?? "",
  examination: v.examination ?? "",
  provisionalDiagnosis: v.provisionalDiagnosis ?? "",
  finalDiagnosis: v.finalDiagnosis ?? "",
  investigations: ((v.investigations ?? []) as any[]).map(
    (x: any): { labTestId: string | null; name: string; note: string } => ({
      labTestId: x.labTest ? String(x.labTest) : null,
      name: x.name,
      note: x.note ?? "",
    }),
  ),
  prescription: (v.prescription ?? []).map(toItemView) as ItemView[],
  adviceEn: v.adviceEn ?? "",
  adviceBn: v.adviceBn ?? "",
  followUp:
    v.followUp?.date || v.followUp?.note ? { date: v.followUp.date ?? null, note: v.followUp.note ?? "" } : null,
  referral: v.referral?.to ? { to: v.referral.to, reason: v.referral.reason ?? "" } : null,
  aiSummaryUsed: Boolean(v.aiSummaryUsed),
});

export const toVisitView = (v: any, vitals: any = null) => ({
  id: String(v._id),
  appointmentId: String(v.appointment?._id ?? v.appointment),
  date: v.date,
  status: v.status,
  prescriptionNo: v.prescriptionNo ?? null,
  ...contentOf(v),
  allergyOverrides: (v.allergyOverrides ?? []).map((o: any) => ({
    medicine: o.medicine,
    allergy: o.allergy,
    reason: o.reason,
    at: o.at,
  })),
  vitals: v.status === "closed" ? (v.vitalsSnapshot ?? null) : vitals,
  openedAt: v.openedAt,
  closedAt: v.closedAt ?? null,
  addenda: ((v.addenda ?? []) as any[]).map(
    (a: any): { id: string; text: string; reason: string; byName: string; at: Date } => ({
      id: String(a._id),
      text: a.text,
      reason: a.reason,
      byName: a.byName,
      at: a.at,
    }),
  ),
  patient: v.patient?._id
    ? {
        id: String(v.patient._id),
        name: v.patient.name,
        nameBn: v.patient.nameBn,
        patientCode: v.patient.patientCode,
        gender: v.patient.gender,
        age: ageOn(v.patient.dateOfBirth),
        bloodGroup: v.patient.bloodGroup ?? null,
        allergies: v.patient.allergies ?? [],
        chronicConditions: v.patient.chronicConditions ?? [],
      }
    : { id: String(v.patient) },
  doctor: v.doctor?._id
    ? {
        id: String(v.doctor._id),
        displayName: `${v.doctor.title ?? ""} ${v.doctor.name}`.trim(),
        nameBn: v.doctor.nameBn,
        degrees: v.doctor.degrees ?? "",
        specialization: v.doctor.specialization ?? "",
      }
    : { id: String(v.doctor) },
  appointment: v.appointment?._id
    ? { id: String(v.appointment._id), serialNo: v.appointment.serialNo, type: v.appointment.type }
    : { id: String(v.appointment) },
});
export type VisitView = ReturnType<typeof toVisitView>;

const populateVisit = (doc: VisitDocument) =>
  doc.populate([
    { path: "patient", select: PATIENT_FIELDS },
    { path: "doctor", select: DOCTOR_FIELDS },
    { path: "appointment", select: "serialNo type status" },
  ]);

/** Full view: open visits show the nurse's current reading, closed ones the stored snapshot */
const fullView = async (doc: VisitDocument) => {
  const vitals =
    doc.status === "open" ? await VitalsModel.findOne({ appointment: doc.appointment?._id ?? doc.appointment }) : null;
  await populateVisit(doc);
  return toVisitView(doc, vitals ? toVitalsView(vitals) : null);
};

// ------------------------------------------------------------------ loading + ownership

const loadVisit = async (id: string) => {
  if (!Types.ObjectId.isValid(id)) throw new AppError(400, "Invalid visit id.", "INVALID_ID");
  const doc = (await VisitModel.findById(id)) as VisitDocument | null;
  if (!doc) throw new AppError(404, "Visit not found.");
  return doc;
};

/** Only the doctor of this visit may write it (403 + audit otherwise) */
const assertAuthor = async (req: Request, visit: VisitDocument) => {
  const me = await doctorIdOf(req.user!);
  await assertCanAccess(req, Boolean(me) && me === String(visit.doctor), {
    entityType: "Visit",
    entityId: String(visit._id),
  });
};

const assertOpen = (visit: VisitDocument) => {
  if (visit.status !== "open")
    throw new AppError(409, "This visit is closed and cannot be changed. Add an addendum instead.", "VISIT_CLOSED");
};

const notifyVisit = (visit: VisitDocument, event: "visit:updated" | "visit:closed") =>
  emitToRoom(`doctor:${String(visit.doctor)}`, event, {
    visitId: String(visit._id),
    appointmentId: String(visit.appointment?._id ?? visit.appointment),
    patientId: String(visit.patient?._id ?? visit.patient),
  });

/** A visit's full view without writing an audit entry — callers audit what they do with it */
export const loadVisitView = async (id: string) => fullView(await loadVisit(id));

// ------------------------------------------------------------------ start

/**
 * Open the record for an appointment. Idempotent: calling it again returns the same visit.
 * A waiting (checked-in) patient is moved to "in consultation" at the same time.
 */
export const startVisit = async (req: Request, appointmentId: string) => {
  const appt = await loadAppointment(appointmentId);
  const me = await doctorIdOf(req.user!);
  await assertCanAccess(req, Boolean(me) && me === String(appt.doctor), {
    entityType: "Appointment",
    entityId: appointmentId,
  });

  const existing = (await VisitModel.findOne({ appointment: appt._id })) as VisitDocument | null;
  if (existing) return fullView(existing);

  if (appt.date !== todayInDhaka())
    throw new AppError(409, "A visit can only be started on the day of the appointment.", "CONFLICT");
  if (!["checked_in", "in_consultation"].includes(appt.status))
    throw new AppError(409, "The patient must be checked in before the consultation starts.", "CONFLICT");

  let moved: AppointmentDocument | null = null;
  let visit: VisitDocument | null = null;
  await mongoose.connection.transaction(async (session) => {
    moved = null;
    const fresh = await loadAppointment(appointmentId, session);
    if (fresh.status === "checked_in") {
      const busy = await AppointmentModel.exists({
        doctor: fresh.doctor,
        date: fresh.date,
        status: "in_consultation",
        _id: { $ne: fresh._id },
      }).session(session);
      if (busy)
        throw new AppError(
          409,
          "Another patient is with you. Finish that visit first, or call this patient.",
          "CONFLICT",
        );
      applyTransition(fresh, "in_consultation", { req }, "consultation started");
      await fresh.save({ session });
      moved = fresh;
    }
    const patient = await PatientModel.findById(fresh.patient).session(session);
    [visit] = (await VisitModel.create(
      [
        {
          appointment: fresh._id,
          patient: fresh.patient,
          doctor: fresh.doctor,
          date: fresh.date,
          status: "open",
          pastHistory: (patient?.chronicConditions ?? []).join(", "),
          openedAt: new Date(),
          createdBy: req.user!.id,
        },
      ],
      { session },
    )) as VisitDocument[];
  });

  const created = visit as unknown as VisitDocument;
  await recordAudit({
    req,
    action: "CREATE",
    entityType: "Visit",
    entityId: created._id,
    meta: { appointmentId, patientId: String(appt.patient) },
  });
  if (moved) {
    const v = toAppointmentView(await (moved as AppointmentDocument).populate(appointmentService.POPULATE));
    notifyAppointmentChanged(v);
  }
  return fullView(created);
};

// ------------------------------------------------------------------ read

export const getVisit = async (req: Request, id: string) => {
  const doc = await loadVisit(id);
  await assertEmrAccess(req, String(doc.patient));
  await recordAudit({ req, action: "VIEW", entityType: "Visit", entityId: doc._id, meta: { status: doc.status } });
  return fullView(doc);
};

/** The visit of an appointment, or null when it has not been started */
export const getVisitForAppointment = async (req: Request, appointmentId: string) => {
  const appt = await loadAppointment(appointmentId);
  await assertEmrAccess(req, String(appt.patient));
  const doc = (await VisitModel.findOne({ appointment: appt._id })) as VisitDocument | null;
  if (!doc) return null;
  await recordAudit({ req, action: "VIEW", entityType: "Visit", entityId: doc._id, meta: { status: doc.status } });
  return fullView(doc);
};

// ------------------------------------------------------------------ update (open visits only)

const toItem = (i: ItemInput): PrescriptionItem => {
  const continued = i.durationDays === "continue";
  const durationDays = continued ? null : ((i.durationDays as number | null | undefined) ?? null);
  const auto = buildInstructions({
    dosePattern: i.dosePattern,
    timing: (i.timing ?? null) as MealTiming | null,
    durationDays: continued ? "continue" : durationDays,
  });
  return {
    medicine: i.medicineId ? new Types.ObjectId(i.medicineId) : null,
    brandName: i.brandName,
    genericName: i.genericName ?? "",
    strength: i.strength ?? "",
    form: i.form ?? "",
    dosePattern: i.dosePattern,
    timing: i.timing ?? null,
    durationDays,
    continued,
    route: i.route ?? "oral",
    // The doctor may type their own wording; otherwise it is generated from the dose pattern
    instructionsEn: i.instructionsEn?.trim() || auto.en,
    instructionsBn: i.instructionsBn?.trim() || auto.bn,
    note: i.note ?? "",
  };
};

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Allergy check: every medicine that matches a recorded allergy needs an override with a
 * reason — either sent now or already stored on the visit. Otherwise 409 ALLERGY_CONFLICT.
 */
const checkAllergies = (
  allergies: string[],
  items: PrescriptionItem[],
  stored: { medicine: string; allergy: string }[],
  sent: { medicine: string; allergy: string; reason: string }[],
) => {
  const conflicts = items.flatMap((item) =>
    allergyMatches(allergies, item).map((allergy) => ({ medicine: item.brandName, allergy })),
  );
  const covered = (c: { medicine: string; allergy: string }, list: { medicine: string; allergy: string }[]) =>
    list.some((o) => sameText(o.medicine, c.medicine) && sameText(o.allergy, c.allergy));
  const missing = conflicts.filter((c) => !covered(c, stored) && !covered(c, sent));
  if (missing.length) {
    throw new AppError(
      409,
      `Allergy warning: ${missing.map((c) => `${c.medicine} (patient is allergic to ${c.allergy})`).join(", ")}. ` +
        "Remove the medicine or confirm with a reason.",
      "ALLERGY_CONFLICT",
      { conflicts: missing },
    );
  }
  // Only overrides that answer a real, not-yet-covered conflict are stored
  return sent.filter((o) => conflicts.some((c) => covered(c, [o])) && !covered(o, stored));
};

export const updateVisit = async (req: Request, id: string, patch: VisitPatch) => {
  const doc = await loadVisit(id);
  await assertAuthor(req, doc);
  assertOpen(doc);
  const before = contentOf(doc);

  for (const key of EDITABLE) {
    if (!(key in patch)) continue;
    if (key === "prescription") doc.prescription = (patch.prescription ?? []).map(toItem);
    else if (key === "investigations")
      doc.investigations = (patch.investigations ?? []).map((x) => ({
        labTest: x.labTestId ? new Types.ObjectId(x.labTestId) : null,
        name: x.name,
        note: x.note ?? "",
      }));
    else doc.set(key, patch[key] ?? null);
  }

  const newOverrides: { medicine: string; allergy: string; reason: string }[] = [];
  if ("prescription" in patch || patch.allergyOverrides?.length) {
    const patient = await PatientModel.findById(doc.patient).select("allergies");
    const accepted = checkAllergies(
      patient?.allergies ?? [],
      doc.prescription,
      doc.allergyOverrides,
      patch.allergyOverrides ?? [],
    );
    for (const o of accepted) {
      doc.allergyOverrides.push({ ...o, by: new Types.ObjectId(req.user!.id), at: new Date() });
      newOverrides.push(o);
    }
  }

  doc.updatedBy = new Types.ObjectId(req.user!.id);
  await doc.save();

  const after = contentOf(doc);
  const changed = (Object.keys(after) as (keyof typeof after)[]).filter(
    (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
  );
  if (changed.length) {
    await recordAudit({
      req,
      action: "UPDATE",
      entityType: "Visit",
      entityId: doc._id,
      before: Object.fromEntries(changed.map((k) => [k, before[k]])),
      after: Object.fromEntries(changed.map((k) => [k, after[k]])),
    });
  }
  for (const o of newOverrides) {
    await recordAudit({
      req,
      action: "UPDATE",
      entityType: "Visit",
      entityId: doc._id,
      meta: { allergyOverride: o },
    });
  }
  notifyVisit(doc, "visit:updated");

  const view = await fullView(doc);
  return { visit: view, warnings: { duplicateGenerics: duplicateGenerics(doc.prescription) } };
};

// ------------------------------------------------------------------ close

/**
 * Sign and close the visit, in ONE transaction with completing the appointment. After this
 * the record is read-only. Publishes visit.closed (follow-up reminders in Phase 6) and
 * appointment.completed (with the visit id).
 */
export const closeVisit = async (req: Request, id: string) => {
  const doc = await loadVisit(id);
  await assertAuthor(req, doc);
  assertOpen(doc);
  if (!doc.provisionalDiagnosis?.trim() && !doc.finalDiagnosis?.trim())
    throw new AppError(400, "Write a diagnosis (provisional or final) before closing the visit.", "VALIDATION_ERROR");
  if (doc.followUp?.date && doc.followUp.date <= doc.date)
    throw new AppError(400, "The follow-up date must be after today.", "VALIDATION_ERROR");

  let completed: AppointmentDocument | null = null;
  let labOrder: LabOrderDocument | null = null;
  await mongoose.connection.transaction(async (session) => {
    completed = null;
    labOrder = null;
    const visit = (await VisitModel.findById(doc._id).session(session)) as VisitDocument;
    assertOpen(visit);
    const vitals = await VitalsModel.findOne({ appointment: visit.appointment }).session(session);
    visit.status = "closed";
    visit.closedAt = new Date();
    visit.closedBy = new Types.ObjectId(req.user!.id);
    visit.vitalsSnapshot = vitals ? toVitalsView(vitals) : null;
    visit.prescriptionNo = await nextCode("prescription", "RX", session);
    visit.updatedBy = visit.closedBy;
    await visit.save({ session });

    // Catalogue tests in "Investigations" that were not sent to the lab yet are ordered now
    const labTestIds = visit.investigations.filter((i) => i.labTest).map((i) => String(i.labTest));
    if (labTestIds.length) labOrder = await createOrderForVisit({ visit, labTestIds, userId: req.user!.id, session });

    const appt = await loadAppointment(String(visit.appointment), session);
    if (appt.status === "in_consultation" || appt.status === "checked_in") {
      if (appt.status === "checked_in") applyTransition(appt, "in_consultation", { req });
      applyTransition(appt, "completed", { req }, "visit closed");
      await appt.save({ session });
      completed = appt;
    }
    await PatientModel.updateOne({ _id: visit.patient }, { $set: { lastVisitDate: visit.date } }, { session });
    doc.set(visit.toObject());
  });

  const closed = (await loadVisit(id)) as VisitDocument;
  await recordAudit({
    req,
    action: "UPDATE",
    entityType: "Visit",
    entityId: closed._id,
    before: { status: "open" },
    after: { status: "closed", prescriptionNo: closed.prescriptionNo },
    meta: { event: "close", items: closed.prescription.length },
  });
  if (completed) {
    const v = toAppointmentView(await (completed as AppointmentDocument).populate(appointmentService.POPULATE));
    notifyAppointmentChanged(v);
    publishAppointmentStatus(v, "in_consultation", { visitId: String(closed._id) });
  }
  void publish("visit.closed", {
    visitId: String(closed._id),
    appointmentId: String(closed.appointment),
    patientId: String(closed.patient),
    doctorId: String(closed.doctor),
    date: closed.date,
    followUpDate: closed.followUp?.date ?? null,
  });
  if (labOrder) await announceNewOrder(req, labOrder);
  notifyVisit(closed, "visit:closed");
  return fullView(closed);
};

// ------------------------------------------------------------------ addenda

/** A correction to a closed record. The original text stays; the addendum says what and why. */
export const addAddendum = async (req: Request, id: string, input: { text: string; reason: string }) => {
  const doc = await loadVisit(id);
  await assertEmrAccess(req, String(doc.patient));
  if (doc.status !== "closed")
    throw new AppError(409, "The visit is still open — edit it directly instead of adding an addendum.", "CONFLICT");
  const at = new Date();
  const byName = req.user!.name ?? req.user!.email;
  doc.addenda.push({ text: input.text, reason: input.reason, by: new Types.ObjectId(req.user!.id), byName, at });
  await doc.save();
  const added = doc.addenda[doc.addenda.length - 1] as any;
  await recordAudit({
    req,
    action: "CREATE",
    entityType: "VisitAddendum",
    entityId: added._id,
    after: { text: input.text, reason: input.reason },
    meta: { visitId: String(doc._id), patientId: String(doc.patient) },
  });
  return fullView(doc);
};

// ------------------------------------------------------------------ patient history (EMR)

/** Everything a doctor needs about the patient's past: visits, vitals trend. Audited as a VIEW. */
export const patientEmr = async (req: Request, patientId: string) => {
  await assertEmrAccess(req, patientId);
  const patient = await PatientModel.findById(patientId);
  if (!patient) throw new AppError(404, "Patient not found.");
  await recordAudit({ req, action: "VIEW", entityType: "Patient", entityId: patientId, meta: { view: "emr" } });

  const visits = await VisitModel.find({ patient: patientId })
    .sort({ date: -1, openedAt: -1 })
    .limit(50)
    .populate("doctor", DOCTOR_FIELDS)
    .lean<any[]>();
  return {
    patient: {
      id: String(patient._id),
      name: patient.name,
      nameBn: patient.nameBn,
      patientCode: patient.patientCode,
      gender: patient.gender,
      age: ageOn(patient.dateOfBirth),
      bloodGroup: patient.bloodGroup ?? null,
      allergies: patient.allergies ?? [],
      chronicConditions: patient.chronicConditions ?? [],
      lastVisitDate: patient.lastVisitDate ?? null,
    },
    visits: visits.map((v) => ({
      id: String(v._id),
      appointmentId: String(v.appointment),
      date: v.date,
      status: v.status,
      prescriptionNo: v.prescriptionNo ?? null,
      doctor: { id: String(v.doctor._id), displayName: `${v.doctor.title ?? ""} ${v.doctor.name}`.trim() },
      chiefComplaints: v.chiefComplaints ?? [],
      diagnosis: v.finalDiagnosis || v.provisionalDiagnosis || "",
      medicines: (v.prescription ?? []).map((i: any) => `${i.brandName}${i.strength ? ` ${i.strength}` : ""}`),
      followUpDate: v.followUp?.date ?? null,
      addendaCount: (v.addenda ?? []).length,
    })),
    vitals: await patientVitalsHistory(patientId, 20),
  };
};

// ------------------------------------------------------------------ the doctor's day

/** Numbers for the doctor's dashboard: today's visits and follow-ups due */
export const doctorToday = async (req: Request) => {
  const doctorId = await doctorIdOf(req.user!);
  if (!doctorId) throw new AppError(404, "Your account is not linked to a doctor profile.");
  const today = todayInDhaka();
  const [visits, followUpsDue, waiting] = await Promise.all([
    VisitModel.find({ doctor: doctorId, date: today })
      .sort({ openedAt: -1 })
      .populate("patient", "name patientCode gender dateOfBirth")
      .lean<any[]>(),
    VisitModel.countDocuments({ doctor: doctorId, status: "closed", "followUp.date": today }),
    AppointmentModel.countDocuments({ doctor: doctorId, date: today, status: "checked_in" }),
  ]);
  return {
    doctorId,
    date: today,
    waiting,
    open: visits.filter((v) => v.status === "open").length,
    closed: visits.filter((v) => v.status === "closed").length,
    followUpsDue,
    visits: visits.map((v) => ({
      id: String(v._id),
      appointmentId: String(v.appointment),
      status: v.status,
      openedAt: v.openedAt,
      closedAt: v.closedAt ?? null,
      diagnosis: v.finalDiagnosis || v.provisionalDiagnosis || "",
      patient: {
        id: String(v.patient._id),
        name: v.patient.name,
        patientCode: v.patient.patientCode,
        gender: v.patient.gender,
        age: ageOn(v.patient.dateOfBirth),
      },
    })),
  };
};

// ------------------------------------------------------------------ prescription templates (own only)

export type TemplateInput = {
  name: string;
  diagnosis?: string;
  items: ItemInput[];
  adviceEn?: string;
  adviceBn?: string;
  investigations?: { labTestId?: string | null; name: string; note?: string }[];
};

const toTemplateView = (t: any) => ({
  id: String(t._id),
  name: t.name,
  diagnosis: t.diagnosis ?? "",
  items: (t.items ?? []).map(toItemView),
  adviceEn: t.adviceEn ?? "",
  adviceBn: t.adviceBn ?? "",
  investigations: (t.investigations ?? []).map((x: any) => ({
    labTestId: x.labTest ? String(x.labTest) : null,
    name: x.name,
    note: x.note ?? "",
  })),
  updatedAt: t.updatedAt,
});

const templateFields = (input: Partial<TemplateInput>) => ({
  ...(input.name !== undefined && { name: input.name }),
  ...(input.diagnosis !== undefined && { diagnosis: input.diagnosis }),
  ...(input.items !== undefined && { items: input.items.map(toItem) }),
  ...(input.adviceEn !== undefined && { adviceEn: input.adviceEn }),
  ...(input.adviceBn !== undefined && { adviceBn: input.adviceBn }),
  ...(input.investigations !== undefined && {
    investigations: input.investigations.map((x) => ({
      labTest: x.labTestId ? new Types.ObjectId(x.labTestId) : null,
      name: x.name,
      note: x.note ?? "",
    })),
  }),
});

/** Other doctors' templates answer 404: their existence is private */
const loadOwnTemplate = async (req: Request, id: string) => {
  if (!Types.ObjectId.isValid(id)) throw new AppError(400, "Invalid template id.", "INVALID_ID");
  const t = await PrescriptionTemplateModel.findOne({ _id: id, owner: req.user!.id });
  if (!t) throw new AppError(404, "Template not found.");
  return t;
};

export const listTemplates = async (req: Request) =>
  (await PrescriptionTemplateModel.find({ owner: req.user!.id }).sort({ name: 1 }).lean<any[]>()).map(toTemplateView);

export const createTemplate = async (req: Request, input: TemplateInput) => {
  const t = await PrescriptionTemplateModel.create({
    owner: req.user!.id,
    createdBy: req.user!.id,
    ...templateFields(input),
  });
  await recordAudit({
    req,
    action: "CREATE",
    entityType: "PrescriptionTemplate",
    entityId: t._id,
    after: { name: t.name },
  });
  return toTemplateView(t);
};

export const updateTemplate = async (req: Request, id: string, input: Partial<TemplateInput>) => {
  const t = await loadOwnTemplate(req, id);
  t.set({ ...templateFields(input), updatedBy: req.user!.id });
  await t.save();
  await recordAudit({
    req,
    action: "UPDATE",
    entityType: "PrescriptionTemplate",
    entityId: t._id,
    after: { name: t.name },
  });
  return toTemplateView(t);
};

export const deleteTemplate = async (req: Request, id: string) => {
  const t = await loadOwnTemplate(req, id);
  await t.softDelete(req.user!.id);
  await recordAudit({
    req,
    action: "DELETE",
    entityType: "PrescriptionTemplate",
    entityId: t._id,
    before: { name: t.name },
  });
};

/** Used by the queue: "call next" must not silently complete a patient whose record is still open */
export const hasOpenVisit = async (appointmentId: Types.ObjectId | string) =>
  Boolean(await VisitModel.exists({ appointment: appointmentId, status: "open" }));

export const visitService = {
  startVisit,
  getVisit,
  getVisitForAppointment,
  updateVisit,
  closeVisit,
  addAddendum,
  patientEmr,
  doctorToday,
  listTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
};

// The QR on a printed prescription is checked here (public verify page)
registerDocumentResolver("RX", async (prescriptionNo) => {
  const v = await VisitModel.findOne({ prescriptionNo, status: "closed" })
    .populate("patient", "name dateOfBirth")
    .populate("doctor", "title name")
    .lean<any>();
  if (!v) return null;
  return {
    type: "prescription",
    number: prescriptionNo,
    date: v.date,
    issuedBy: `${v.doctor.title ?? ""} ${v.doctor.name}`.trim(),
    patient: maskName(v.patient.name),
    patientAge: ageOn(v.patient.dateOfBirth, v.date),
    signedAt: v.closedAt ?? null,
    corrections: (v.addenda ?? []).length,
  };
});
