/* eslint-disable @typescript-eslint/no-explicit-any */
import { Request } from "express";
import { Types } from "mongoose";
import AppError from "../../../errors/AppError";
import { computeBmi, flagVitals, VitalsInput, worstLevel } from "../../../shared/clinical-rules";
import { emitToPermission, emitToRoom } from "../../../sockets";
import { ageOn, todayInDhaka } from "../../../utils/date";
import { recordAudit } from "../../audit/audit.service";
import { AppointmentModel } from "../../hospital/appointment/appointment.model";
import { loadAppointment } from "../../hospital/appointment/appointment.service";
import { compareQueue } from "../../hospital/queue/queue.service";
import { VitalsDocument, VitalsModel } from "./vitals.model";

export type VitalsBody = VitalsInput & { notes?: string };

const MEASUREMENTS = [
  "bpSystolic",
  "bpDiastolic",
  "pulse",
  "temperatureF",
  "respiratoryRate",
  "spo2",
  "weightKg",
  "heightCm",
] as const;

/** Only the clinical values (for audit snapshots and API responses) */
export const toVitalsView = (v: any) => ({
  id: String(v._id),
  appointmentId: String(v.appointment),
  patientId: String(v.patient),
  date: v.date,
  ...Object.fromEntries(MEASUREMENTS.map((k) => [k, v[k] ?? null])),
  bmi: v.bmi ?? null,
  bloodSugar: v.bloodSugar?.value ? { value: v.bloodSugar.value, type: v.bloodSugar.type ?? null } : null,
  notes: v.notes ?? "",
  flags: (v.flags ?? []).map((f: any) => ({ key: f.key, level: f.level, label: f.label, labelBn: f.labelBn })),
  flagLevel: v.flagLevel,
  recordedAt: v.recordedAt,
  recordedBy: v.recordedBy?.name ? { id: String(v.recordedBy._id), name: v.recordedBy.name } : String(v.recordedBy),
});
export type VitalsView = ReturnType<typeof toVitalsView>;

/** Apply values + recompute BMI and flags with the SAME rules the browser uses */
const applyValues = (doc: VitalsDocument, input: VitalsBody) => {
  for (const k of MEASUREMENTS) if (k in input) doc.set(k, input[k] ?? null);
  if ("bloodSugar" in input)
    doc.bloodSugar = input.bloodSugar?.value
      ? { value: input.bloodSugar.value, type: input.bloodSugar.type ?? "random" }
      : null;
  if ("notes" in input) doc.notes = input.notes ?? "";
  doc.bmi = computeBmi(doc.weightKg, doc.heightCm);
  const flags = flagVitals({ ...doc.toObject(), bloodSugar: doc.bloodSugar ?? null });
  doc.flags = flags;
  doc.flagLevel = worstLevel(flags);
};

/** Tell the nurse list, the doctor's screen and queue viewers that vitals changed (ids only) */
const notifyVitals = (v: { appointmentId: string; patientId: string }, doctorId: string) => {
  const signal = { appointmentId: v.appointmentId, patientId: v.patientId, doctorId };
  emitToPermission("vitals:read", "vitals:updated", signal);
  emitToRoom(`doctor:${doctorId}`, "vitals:updated", signal);
};

const assertRecordable = (appt: any) => {
  if (appt.date !== todayInDhaka())
    throw new AppError(409, "Vitals can only be recorded for today's patients.", "CONFLICT");
  if (!["checked_in", "in_consultation"].includes(appt.status)) {
    throw new AppError(409, "Check the patient in first. Vitals are taken while the patient is waiting.", "CONFLICT");
  }
};

export const recordVitals = async (req: Request, appointmentId: string, input: VitalsBody) => {
  const appt = await loadAppointment(appointmentId);
  assertRecordable(appt);
  if (await VitalsModel.exists({ appointment: appt._id })) {
    throw new AppError(409, "Vitals are already recorded for this visit. Edit them instead.", "CONFLICT");
  }
  const doc = new VitalsModel({
    appointment: appt._id,
    patient: appt.patient,
    doctor: appt.doctor,
    date: appt.date,
    recordedBy: req.user!.id,
    recordedAt: new Date(),
    createdBy: req.user!.id,
  }) as VitalsDocument;
  applyValues(doc, input);
  await doc.save();

  const view = toVitalsView(doc);
  await recordAudit({ req, action: "CREATE", entityType: "Vitals", entityId: doc._id, after: view });
  notifyVitals(view, String(appt.doctor));
  return view;
};

/**
 * Corrections are allowed while the patient is still waiting. Once the consultation has
 * started the doctor owns the record: they correct the vitals inside the visit instead.
 */
export const updateVitals = async (req: Request, appointmentId: string, input: VitalsBody) => {
  const appt = await loadAppointment(appointmentId);
  const doc = (await VitalsModel.findOne({ appointment: appt._id })) as VitalsDocument | null;
  if (!doc) throw new AppError(404, "No vitals recorded for this visit yet.");
  if (appt.status !== "checked_in") {
    throw new AppError(409, "The consultation has started. The doctor can correct vitals in the visit.", "CONFLICT");
  }
  const before = toVitalsView(doc);
  applyValues(doc, input);
  doc.updatedBy = new Types.ObjectId(req.user!.id);
  await doc.save();

  const after = toVitalsView(doc);
  await recordAudit({ req, action: "UPDATE", entityType: "Vitals", entityId: doc._id, before, after });
  notifyVitals(after, String(appt.doctor));
  return after;
};

export const getVitalsForAppointment = async (appointmentId: string) => {
  const doc = await VitalsModel.findOne({ appointment: appointmentId }).populate("recordedBy", "name");
  return doc ? toVitalsView(doc) : null;
};

/** A patient's readings, newest first (history table and trend charts) */
export const patientVitalsHistory = async (patientId: string, limit = 20) => {
  const docs = await VitalsModel.find({ patient: patientId })
    .sort({ recordedAt: -1 })
    .limit(limit)
    .populate("recordedBy", "name");
  return docs.map(toVitalsView);
};

/**
 * The nurse's list: today's checked-in / in-consultation patients (all doctors, or one),
 * in queue order, each with whether vitals are recorded and their worst flag.
 */
export const nurseWorklist = async (doctorId?: string) => {
  const filter: Record<string, unknown> = { date: todayInDhaka(), status: { $in: ["checked_in", "in_consultation"] } };
  if (doctorId) filter.doctor = doctorId;
  const appts = await AppointmentModel.find(filter)
    .populate("patient", "name nameBn patientCode gender dateOfBirth allergies chronicConditions")
    .populate("doctor", "title name roomNo")
    .lean<any[]>();
  const vitals = await VitalsModel.find({ appointment: { $in: appts.map((a) => a._id) } }).lean<any[]>();
  const byAppt = new Map(vitals.map((v) => [String(v.appointment), v]));
  const now = Date.now();

  return appts
    .sort((a, b) => compareQueue(a, b))
    .map((a) => {
      const v = byAppt.get(String(a._id));
      return {
        appointmentId: String(a._id),
        serialNo: a.serialNo,
        status: a.status,
        priority: a.priority,
        type: a.type,
        checkedInAt: a.checkedInAt,
        waitingMinutes: a.checkedInAt
          ? Math.max(0, Math.round((now - new Date(a.checkedInAt).getTime()) / 60000))
          : null,
        doctor: {
          id: String(a.doctor._id),
          displayName: `${a.doctor.title ?? ""} ${a.doctor.name}`.trim(),
          roomNo: a.doctor.roomNo,
        },
        patient: {
          id: String(a.patient._id),
          name: a.patient.name,
          nameBn: a.patient.nameBn,
          patientCode: a.patient.patientCode,
          gender: a.patient.gender,
          age: ageOn(a.patient.dateOfBirth),
          allergies: a.patient.allergies ?? [],
        },
        vitals: v
          ? { recorded: true, flagLevel: v.flagLevel, flags: v.flags, recordedAt: v.recordedAt }
          : { recorded: false },
      };
    });
};

export const vitalsService = {
  recordVitals,
  updateVitals,
  getVitalsForAppointment,
  patientVitalsHistory,
  nurseWorklist,
};
