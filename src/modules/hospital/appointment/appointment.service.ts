/* eslint-disable @typescript-eslint/no-explicit-any */
import { Request } from "express";
import mongoose, { ClientSession, Types } from "mongoose";
import AppError from "../../../errors/AppError";
import { buildPagination } from "../../../interface/global.interface";
import { getNextSequence } from "../../../models/counter.model";
import { addDays, ageOn, nowMinutesInDhaka, sessionLabel, todayInDhaka, toMinutes } from "../../../utils/date";
import { escapeRegex } from "../../../utils/escapeRegex";
import { recordAudit } from "../../audit/audit.service";
import { findPatientOrThrow } from "../../patients/patient.service";
import { PatientModel } from "../../patients/patient.model";
import { assertBookableDate, getDaySlotsFor, loadActiveDoctor } from "../scheduling/scheduling.service";
import type { DaySlots } from "../scheduling/slotEngine";
import {
  ACTIVE_STATUSES,
  AppointmentDocument,
  AppointmentModel,
  AppointmentSource,
  AppointmentStatus,
  Priority,
} from "./appointment.model";
import { notifyAppointmentChanged, publishAppointmentStatus } from "./appointment.events";
import { publish } from "../../../events/bus";

/**
 * BOOKING SERVICE — the ONE place appointments are created and moved between statuses.
 * Reception screens, the walk-in button, and (Phase 5) the chatbot and WhatsApp all call
 * these functions, so every channel gets the same rules, serials, audit trail and events.
 */

// ------------------------------------------------------------------ status rules

// Which status changes are allowed. Anything else is rejected with a clear message.
export const ALLOWED_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  booked: ["checked_in", "cancelled", "no_show"],
  checked_in: ["in_consultation", "cancelled"],
  in_consultation: ["completed", "checked_in"], // back to checked_in = "send back to waiting"
  completed: [],
  cancelled: [],
  no_show: [],
};

export const assertTransition = (from: AppointmentStatus, to: AppointmentStatus) => {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new AppError(
      409,
      `An appointment that is "${from.replace("_", " ")}" cannot become "${to.replace("_", " ")}".`,
      "CONFLICT",
      { from, to },
    );
  }
};

/** Actor of a change: a signed-in staff member (req) or a system channel such as the chatbot */
export type Actor = { req?: Request; label?: string };
const actorId = (actor: Actor) => (actor.req?.user?.id ? new Types.ObjectId(actor.req.user.id) : null);

/**
 * Apply a status change to a loaded appointment (no save): checks the rule, appends to
 * statusHistory, stamps the matching timestamp and releases the slot for final states.
 */
export const applyTransition = (appt: AppointmentDocument, to: AppointmentStatus, actor: Actor, note?: string) => {
  assertTransition(appt.status, to);
  const now = new Date();
  appt.status = to;
  appt.holdsSlot = ACTIVE_STATUSES.includes(to);
  appt.statusHistory.push({ status: to, at: now, by: actorId(actor), ...(note && { note }) });
  if (to === "checked_in" && !appt.checkedInAt) appt.checkedInAt = now;
  if (to === "in_consultation") {
    appt.calledAt = now;
    appt.consultationStartedAt = now;
  }
  if (to === "completed") appt.completedAt = now;
  if (to === "cancelled") {
    appt.cancelledAt = now;
    appt.cancelReason = note ?? null;
  }
  if (actor.req?.user) appt.updatedBy = new Types.ObjectId(actor.req.user.id);
};

// ------------------------------------------------------------------ serialisation

const POPULATE = [
  { path: "patient", select: "name nameBn patientCode phone gender dateOfBirth dobEstimated allergies" },
  { path: "doctor", select: "title name nameBn roomNo averageMinutesPerPatient user" },
  { path: "department", select: "name nameBn" },
];

/** The one shape of an appointment in API responses (patient data = basic view only) */
export const toAppointmentView = (a: any) => ({
  id: String(a._id),
  date: a.date,
  slotTime: a.slotTime,
  sessionKey: a.sessionKey,
  sessionLabel: sessionLabel(a.sessionKey.slice(0, 5)).label,
  serialNo: a.serialNo,
  type: a.type,
  fee: a.feeSnapshot,
  source: a.source,
  status: a.status,
  priority: a.priority,
  notes: a.notes,
  checkedInAt: a.checkedInAt,
  calledAt: a.calledAt,
  consultationStartedAt: a.consultationStartedAt,
  completedAt: a.completedAt,
  cancelledAt: a.cancelledAt,
  cancelReason: a.cancelReason,
  rescheduledFrom: a.rescheduledFrom ? String(a.rescheduledFrom) : null,
  rescheduledTo: a.rescheduledTo ? String(a.rescheduledTo) : null,
  confirmedByPatient: Boolean(a.confirmedByPatient),
  confirmedAt: a.confirmedAt ?? null,
  lastReminderSentAt: a.lastReminderSentAt ?? null,
  doctorAbsent: Boolean(a.doctorAbsent),
  statusHistory: (a.statusHistory ?? []).map((h: any) => ({ status: h.status, at: h.at, note: h.note })),
  patient: a.patient?._id
    ? {
        id: String(a.patient._id),
        name: a.patient.name,
        nameBn: a.patient.nameBn,
        patientCode: a.patient.patientCode,
        phone: a.patient.phone,
        gender: a.patient.gender,
        age: ageOn(a.patient.dateOfBirth),
        hasAllergies: (a.patient.allergies ?? []).length > 0,
      }
    : { id: String(a.patient) },
  doctor: a.doctor?._id
    ? {
        id: String(a.doctor._id),
        displayName: `${a.doctor.title ?? ""} ${a.doctor.name}`.trim(),
        nameBn: a.doctor.nameBn,
        roomNo: a.doctor.roomNo,
      }
    : { id: String(a.doctor) },
  department: a.department?._id
    ? { id: String(a.department._id), name: a.department.name, nameBn: a.department.nameBn }
    : { id: String(a.department) },
  createdAt: a.createdAt,
});

export type AppointmentView = ReturnType<typeof toAppointmentView>;

export const loadAppointment = async (id: string, session?: ClientSession) => {
  if (!Types.ObjectId.isValid(id)) throw new AppError(400, "Invalid appointment id.", "INVALID_ID");
  const appt = await AppointmentModel.findById(id).session(session ?? null);
  if (!appt) throw new AppError(404, "Appointment not found.");
  return appt as AppointmentDocument;
};

const view = async (appt: AppointmentDocument) => toAppointmentView(await appt.populate(POPULATE));

// ------------------------------------------------------------------ booking

export type BookInput = {
  patientId: string;
  doctorId: string;
  date: string;
  slotTime?: string; // omitted → the next available slot
  source: AppointmentSource;
  priority?: Priority;
  notes?: string;
  chatSessionId?: string;
  checkInNow?: boolean; // walk-in: book and check in at once
};

const nextSlotsHint = (day: DaySlots) =>
  day.slots
    .filter((s) => s.available)
    .slice(0, 5)
    .map((s) => s.time);

const REASON_TEXT = { booked: "already booked", past: "already over", session_full: "in a full session" } as const;

/** Follow-up if the patient completed a visit with this doctor within followUpValidDays */
const detectVisitType = async (patientId: Types.ObjectId, doctor: any, date: string, session: ClientSession) => {
  if (!doctor.followUpValidDays) return "new" as const;
  const recent = await AppointmentModel.exists({
    patient: patientId,
    doctor: doctor._id,
    status: "completed",
    date: { $gte: addDays(date, -doctor.followUpValidDays), $lt: date },
  }).session(session);
  return recent ? ("follow_up" as const) : ("new" as const);
};

/** The fee this patient would pay (new or follow-up) — shown on confirmation summaries before booking */
export const estimateFee = async (patientId: string, doctor: any, date: string) => {
  const type = await detectVisitType(new Types.ObjectId(patientId), doctor, date, null as unknown as ClientSession);
  return { type, fee: type === "follow_up" ? (doctor.followUpFee as number) : (doctor.consultationFee as number) };
};

/** Book inside an existing transaction (used by bookAppointment and rescheduleAppointment) */
const bookWithinSession = async (
  input: BookInput,
  actor: Actor,
  session: ClientSession,
  extra: { rescheduledFrom?: Types.ObjectId } = {},
) => {
  const doctor = await loadActiveDoctor(input.doctorId, session);
  const patient = await findPatientOrThrow(input.patientId, session);
  const day = await getDaySlotsFor(doctor, input.date, session);

  if (day.onLeave)
    throw new AppError(
      400,
      `The doctor is on leave on ${input.date}${day.leaveReason ? ` (${day.leaveReason})` : ""}.`,
    );
  if (!day.sessions.length)
    throw new AppError(400, `The doctor does not sit on ${input.date}. Please choose another day.`);

  const slot = input.slotTime ? day.slots.find((s) => s.time === input.slotTime) : day.nextAvailable;
  if (input.slotTime && !slot)
    throw new AppError(400, `${input.slotTime} is not in the doctor's schedule on ${input.date}.`);
  if (!slot) throw new AppError(409, "No free slots left on this day.", "CONFLICT", { nextSlots: [] });
  if (!slot.available) {
    throw new AppError(409, `${slot.time} is ${REASON_TEXT[slot.reason!]}. Please choose another time.`, "CONFLICT", {
      nextSlots: nextSlotsHint(day),
    });
  }

  // Friendly check before the unique index would fire
  const existing = await AppointmentModel.findOne({
    patient: patient._id,
    doctor: doctor._id,
    date: input.date,
    holdsSlot: true,
  }).session(session);
  if (existing) {
    throw new AppError(
      409,
      `This patient already has serial ${existing.serialNo} with this doctor on ${input.date} at ${existing.slotTime}.`,
      "CONFLICT",
      {
        existingAppointmentId: String(existing._id),
      },
    );
  }

  const type = await detectVisitType(patient._id, doctor, input.date, session);
  // Atomic $inc inside the transaction: if the transaction aborts, the number is not used
  const serialNo = await getNextSequence(`serial:${input.date}:${doctor._id}:${slot.sessionKey}`, session);
  const now = new Date();
  const status: AppointmentStatus = input.checkInNow ? "checked_in" : "booked";
  const by = actorId(actor);

  const [appt] = await AppointmentModel.create(
    [
      {
        patient: patient._id,
        doctor: doctor._id,
        department: doctor.department._id ?? doctor.department,
        date: input.date,
        slotTime: slot.time,
        sessionKey: slot.sessionKey,
        serialNo,
        type,
        feeSnapshot: type === "follow_up" ? doctor.followUpFee : doctor.consultationFee,
        source: input.source,
        priority: input.priority ?? "normal",
        status,
        holdsSlot: true,
        statusHistory: [
          { status: "booked", at: now, by },
          ...(input.checkInNow ? [{ status: "checked_in" as const, at: now, by, note: "walk-in" }] : []),
        ],
        checkedInAt: input.checkInNow ? now : null,
        notes: input.notes,
        chatSessionId: input.chatSessionId ?? null,
        rescheduledFrom: extra.rescheduledFrom ?? null,
        createdBy: by,
      },
    ],
    { session },
  );
  return appt as AppointmentDocument;
};

/** Duplicate-key (E11000) from one of the two unique indexes → friendly 409 with next free slots */
const translateDuplicate = async (err: any, input: BookInput): Promise<never> => {
  if (err?.code !== 11000) throw err;
  const doctor = await loadActiveDoctor(input.doctorId).catch(() => null);
  const day = doctor ? await getDaySlotsFor(doctor, input.date) : null;
  const samePatient = String(err?.message ?? "").includes("uniq_active_patient_doctor_day");
  throw new AppError(
    409,
    samePatient
      ? "This patient already has an appointment with this doctor on that day."
      : "That slot was just taken by another booking. Please choose another time.",
    "CONFLICT",
    { nextSlots: day ? nextSlotsHint(day) : [] },
  );
};

/**
 * Book an appointment. Everything that must be consistent happens in ONE transaction:
 * read the free slots, check the patient has no other booking, take the next serial from
 * the counter, insert the appointment. If two requests race for the same slot, the
 * database's unique index lets exactly one commit; the other gets a friendly 409.
 */
export const bookAppointment = async (input: BookInput, actor: Actor = {}) => {
  await assertBookableDate(input.date);
  let created!: AppointmentDocument;
  try {
    await mongoose.connection.transaction(async (session) => {
      created = await bookWithinSession(input, actor, session);
    });
  } catch (err) {
    await translateDuplicate(err, input);
  }

  const result = await view(created);
  await recordAudit({
    req: actor.req,
    action: "CREATE",
    entityType: "Appointment",
    entityId: created._id,
    after: {
      patient: result.patient.patientCode,
      doctor: result.doctor.displayName,
      date: result.date,
      slotTime: result.slotTime,
      serialNo: result.serialNo,
      source: result.source,
      status: result.status,
    },
  });
  notifyAppointmentChanged(result);
  publishAppointmentStatus(result);
  return result;
};

// ------------------------------------------------------------------ status changes

/** Load → apply transition → save → audit → realtime event. Used by every simple status action. */
export const changeStatus = async (
  id: string,
  to: AppointmentStatus,
  actor: Actor,
  opts: { note?: string; session?: ClientSession; assert?: (a: AppointmentDocument) => void } = {},
) => {
  const appt = await loadAppointment(id, opts.session);
  opts.assert?.(appt);
  const from = appt.status;
  applyTransition(appt, to, actor, opts.note);
  await appt.save({ session: opts.session });
  if (to === "completed")
    await PatientModel.updateOne(
      { _id: appt.patient },
      { $set: { lastVisitDate: appt.date } },
      { session: opts.session },
    );
  return { appt, from };
};

const finishChange = async (
  appt: AppointmentDocument,
  from: AppointmentStatus,
  actor: Actor,
  action: "UPDATE" | "DELETE" = "UPDATE",
  meta?: Record<string, unknown>,
  opts: { publishEvent?: boolean } = {},
) => {
  const result = await view(appt);
  await recordAudit({
    req: actor.req,
    action,
    entityType: "Appointment",
    entityId: appt._id,
    before: { status: from },
    after: { status: appt.status },
    meta: { serialNo: appt.serialNo, date: appt.date, ...meta },
  });
  notifyAppointmentChanged(result);
  if (opts.publishEvent !== false) publishAppointmentStatus(result, from);
  return result;
};

export const checkIn = async (id: string, actor: Actor, priority?: Priority) => {
  const { appt, from } = await changeStatus(id, "checked_in", actor, {
    assert: (a) => {
      if (a.date !== todayInDhaka())
        throw new AppError(409, `Only today's appointments can be checked in (this one is on ${a.date}).`, "CONFLICT");
    },
  });
  if (priority && priority !== appt.priority) {
    appt.priority = priority;
    await appt.save();
  }
  return finishChange(appt, from, actor);
};

export const markNoShow = async (id: string, actor: Actor) => {
  const { appt, from } = await changeStatus(id, "no_show", actor, {
    assert: (a) => {
      if (a.date > todayInDhaka())
        throw new AppError(409, "A future appointment cannot be marked as no-show.", "CONFLICT");
    },
  });
  return finishChange(appt, from, actor);
};

/**
 * Cancel. Staff may cancel any time; channels acting for the patient (chatbot, WhatsApp)
 * must respect the hospital's cancellation cut-off (`enforceCutoffMinutes`).
 */
export const cancelAppointment = async (
  id: string,
  reason: string,
  actor: Actor,
  opts: { enforceCutoffMinutes?: number; session?: ClientSession } = {},
) => {
  const { appt, from } = await changeStatus(id, "cancelled", actor, {
    note: reason,
    session: opts.session,
    assert: (a) => {
      if (opts.enforceCutoffMinutes === undefined) return;
      const minutesLeft = a.date === todayInDhaka() ? toMinutes(a.slotTime) - nowMinutesInDhaka() : Infinity;
      if (minutesLeft < opts.enforceCutoffMinutes) {
        throw new AppError(
          409,
          `Appointments can only be cancelled up to ${opts.enforceCutoffMinutes} minutes before the time.`,
          "CONFLICT",
        );
      }
    },
  });
  if (opts.session) return appt; // caller (reschedule) audits and notifies after commit
  return finishChange(appt, from, actor, "UPDATE", { reason });
};

/** Move to another date/time (and optionally another doctor): cancel + rebook in ONE transaction */
export const rescheduleAppointment = async (
  id: string,
  target: { date: string; slotTime?: string; doctorId?: string },
  actor: Actor,
) => {
  await assertBookableDate(target.date);
  const original = await loadAppointment(id);
  if (!["booked", "checked_in"].includes(original.status)) {
    throw new AppError(409, `A "${original.status.replace("_", " ")}" appointment cannot be rescheduled.`, "CONFLICT");
  }
  const input: BookInput = {
    patientId: String(original.patient),
    doctorId: target.doctorId ?? String(original.doctor),
    date: target.date,
    slotTime: target.slotTime,
    source: original.source,
    priority: original.priority,
    notes: original.notes,
  };

  let moved!: AppointmentDocument;
  let cancelled!: AppointmentDocument;
  try {
    await mongoose.connection.transaction(async (session) => {
      // Cancel first so the patient's "one active booking per doctor per day" rule allows the new one
      cancelled = (await cancelAppointment(
        id,
        `Rescheduled to ${target.date}${target.slotTime ? " " + target.slotTime : ""}`,
        actor,
        { session },
      )) as AppointmentDocument;
      moved = await bookWithinSession(input, actor, session, { rescheduledFrom: cancelled._id });
      cancelled.rescheduledTo = moved._id;
      await cancelled.save({ session });
    });
  } catch (err) {
    await translateDuplicate(err, input);
  }

  // One "rescheduled" event instead of "cancelled" + "booked", so automation does not tell the patient it was cancelled
  await finishChange(
    cancelled,
    original.status,
    actor,
    "UPDATE",
    { rescheduledTo: String(moved._id) },
    { publishEvent: false },
  );
  const result = await view(moved);
  await recordAudit({
    req: actor.req,
    action: "CREATE",
    entityType: "Appointment",
    entityId: moved._id,
    after: { serialNo: result.serialNo, date: result.date, slotTime: result.slotTime },
    meta: { rescheduledFrom: id },
  });
  notifyAppointmentChanged(result);
  void publish("appointment.rescheduled", {
    fromAppointmentId: id,
    toAppointmentId: result.id,
    patientId: result.patient.id,
    doctorId: result.doctor.id,
    date: result.date,
    slotTime: result.slotTime,
  });
  return result;
};

// ------------------------------------------------------------------ queries

export type ListFilters = {
  date?: string;
  doctorId?: string;
  status?: AppointmentStatus;
  patientId?: string;
  q?: string;
  page: number;
  limit: number;
  // object-level restriction: a doctor only ever sees their own appointments
  restrictToDoctorId?: string | null;
};

export const listAppointments = async (f: ListFilters) => {
  const filter: Record<string, unknown> = {};
  if (f.date) filter.date = f.date;
  if (f.doctorId) filter.doctor = f.doctorId;
  if (f.restrictToDoctorId !== undefined) {
    if (f.restrictToDoctorId === null) return { items: [], pagination: buildPagination(f.page, f.limit, 0) };
    if (f.doctorId && f.doctorId !== f.restrictToDoctorId)
      return { items: [], pagination: buildPagination(f.page, f.limit, 0) };
    filter.doctor = f.restrictToDoctorId;
  }
  if (f.status) filter.status = f.status;
  if (f.patientId) filter.patient = f.patientId;
  if (f.q) {
    // Search the patient by name, code or phone digits, then list their appointments
    const rx = new RegExp(escapeRegex(f.q), "i");
    const digits = f.q.replace(/\D/g, "");
    const ids = await PatientModel.find({
      $or: [
        { name: rx },
        { patientCode: rx },
        ...(digits.length >= 4 ? [{ phone: new RegExp(escapeRegex(digits)) }] : []),
      ],
    })
      .limit(200)
      .distinct("_id");
    filter.patient = { $in: ids };
  }
  const sort = f.date ? { slotTime: 1, serialNo: 1 } : { date: -1, slotTime: -1 };
  const [items, total] = await Promise.all([
    AppointmentModel.find(filter)
      .sort(sort as any)
      .skip((f.page - 1) * f.limit)
      .limit(f.limit)
      .populate(POPULATE),
    AppointmentModel.countDocuments(filter),
  ]);
  return { items: items.map(toAppointmentView), pagination: buildPagination(f.page, f.limit, total) };
};

export const getAppointment = async (id: string) => view(await loadAppointment(id));

export const appointmentService = {
  bookAppointment,
  checkIn,
  markNoShow,
  cancelAppointment,
  rescheduleAppointment,
  changeStatus,
  listAppointments,
  getAppointment,
  loadAppointment,
  toAppointmentView,
  POPULATE,
};
