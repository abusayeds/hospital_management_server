/* eslint-disable @typescript-eslint/no-explicit-any */
import mongoose, { ClientSession, Types } from "mongoose";
import AppError from "../../../errors/AppError";
import { nowMinutesInDhaka, sessionLabel, todayInDhaka, toMinutes, weekdayOf } from "../../../utils/date";
import { recordAudit } from "../../audit/audit.service";
import { AppointmentDocument, AppointmentModel, PRIORITY_RANK, Priority } from "../appointment/appointment.model";
import { Actor, applyTransition, appointmentService, toAppointmentView } from "../appointment/appointment.service";
import { notifyAppointmentChanged, notifyRecall } from "../appointment/appointment.events";
import { DoctorModel } from "../doctor/doctor.model";
import { findLeave } from "../scheduling/slotEngine";

/**
 * QUEUE RULES (one doctor, one day):
 *   1. the patient IN CONSULTATION is always first
 *   2. then checked-in patients by priority: emergency > elderly > normal
 *   3. then by serial number (arrival order within the same priority)
 * Booked patients who have not checked in are listed separately as "not arrived".
 * Estimated wait = position in the waiting line × the doctor's average minutes per patient.
 */
export const compareQueue = (a: { status: string; priority: Priority; serialNo: number }, b: { status: string; priority: Priority; serialNo: number }) => {
  if (a.status === "in_consultation" && b.status !== "in_consultation") return -1;
  if (b.status === "in_consultation" && a.status !== "in_consultation") return 1;
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.serialNo - b.serialNo;
};

const loadDoctor = async (doctorId: string, session?: ClientSession) => {
  if (!Types.ObjectId.isValid(doctorId)) throw new AppError(400, "Invalid doctor id.", "INVALID_ID");
  const doctor = await DoctorModel.findById(doctorId).populate("department", "name nameBn").session(session ?? null);
  if (!doctor) throw new AppError(404, "Doctor not found.");
  return doctor;
};

/** Today's queue of one doctor, fully ordered, with estimated waiting times */
export const getDoctorQueue = async (doctorId: string, date = todayInDhaka()) => {
  const doctor = await loadDoctor(doctorId);
  const appts = await AppointmentModel.find({ doctor: doctor._id, date }).populate(appointmentService.POPULATE);
  const views = appts.map(toAppointmentView);

  const inLine = views.filter((a) => a.status === "in_consultation" || a.status === "checked_in").sort(compareQueue);
  const current = inLine.find((a) => a.status === "in_consultation") ?? null;
  const waiting = inLine
    .filter((a) => a.status === "checked_in")
    .map((a, i) => ({ ...a, position: i + 1, estimatedWaitMinutes: (i + (current ? 1 : 0)) * doctor.averageMinutesPerPatient }));
  const notArrived = views.filter((a) => a.status === "booked").sort((a, b) => a.slotTime.localeCompare(b.slotTime));
  const count = (s: string) => views.filter((a) => a.status === s).length;

  const leave = findLeave(doctor.leaves ?? [], date);
  const sessions = leave
    ? []
    : (doctor.sessions ?? [])
        .filter((s: any) => s.dayOfWeek === weekdayOf(date))
        .sort((a: any, b: any) => a.startTime.localeCompare(b.startTime))
        .map((s: any) => ({ startTime: s.startTime, endTime: s.endTime, label: sessionLabel(s.startTime).label }));

  return {
    date,
    doctor: {
      id: String(doctor._id),
      displayName: `${doctor.title ?? ""} ${doctor.name}`.trim(),
      department: (doctor.department as any)?.name,
      roomNo: doctor.roomNo,
      averageMinutesPerPatient: doctor.averageMinutesPerPatient,
      sessionsToday: sessions,
      onLeave: Boolean(leave),
    },
    current,
    waiting,
    notArrived,
    stats: {
      total: views.length,
      waiting: waiting.length,
      notArrived: notArrived.length,
      completed: count("completed"),
      noShow: count("no_show"),
      cancelled: count("cancelled"),
    },
  };
};

/** Reception board: every doctor who sits today or has patients today, with a small summary */
export const getTodayBoard = async () => {
  const date = todayInDhaka();
  const [doctors, grouped] = await Promise.all([
    DoctorModel.find({ isActive: true }).populate("department", "name nameBn").sort({ name: 1 }),
    AppointmentModel.aggregate<{ _id: Types.ObjectId; statuses: { status: string; serialNo: number }[] }>([
      { $match: { date } },
      { $group: { _id: "$doctor", statuses: { $push: { status: "$status", serialNo: "$serialNo" } } } },
    ]),
  ]);
  const byDoctor = new Map(grouped.map((g) => [String(g._id), g.statuses]));
  const now = nowMinutesInDhaka();

  return doctors
    .map((d: any) => {
      const rows = byDoctor.get(String(d._id)) ?? [];
      const onLeave = Boolean(findLeave(d.leaves ?? [], date));
      const sessions = onLeave ? [] : (d.sessions ?? []).filter((s: any) => s.dayOfWeek === weekdayOf(date));
      const inSessionNow = sessions.some((s: any) => toMinutes(s.startTime) <= now && now < toMinutes(s.endTime));
      const current = rows.find((r) => r.status === "in_consultation");
      return {
        doctorId: String(d._id),
        displayName: `${d.title ?? ""} ${d.name}`.trim(),
        department: d.department?.name,
        roomNo: d.roomNo,
        onLeave,
        sitsToday: sessions.length > 0,
        inSessionNow,
        sessionsToday: sessions.map((s: any) => `${s.startTime}–${s.endTime}`),
        currentSerial: current?.serialNo ?? null,
        waiting: rows.filter((r) => r.status === "checked_in").length,
        notArrived: rows.filter((r) => r.status === "booked").length,
        completed: rows.filter((r) => r.status === "completed").length,
        total: rows.length,
      };
    })
    .filter((d) => d.sitsToday || d.total > 0);
};

// ------------------------------------------------------------------ doctor actions

const today = () => todayInDhaka();

const findCurrent = (doctorId: Types.ObjectId, session: ClientSession) =>
  AppointmentModel.findOne({ doctor: doctorId, date: today(), status: "in_consultation" }).session(session) as Promise<AppointmentDocument | null>;

const afterQueueChange = async (changed: AppointmentDocument[], actor: Actor, action: string) => {
  for (const appt of changed) {
    const v = toAppointmentView(await appt.populate(appointmentService.POPULATE));
    await recordAudit({ req: actor.req, action: "UPDATE", entityType: "Appointment", entityId: appt._id, after: { status: appt.status }, meta: { queueAction: action, serialNo: appt.serialNo } });
    notifyAppointmentChanged(v);
  }
};

/**
 * CALL NEXT, in ONE transaction: the patient with the doctor is marked completed and the
 * next patient in line becomes "in consultation". Two quick clicks cannot skip or double-call
 * a patient, because both steps commit together or not at all.
 */
export const callNext = async (doctorId: string, actor: Actor) => {
  const doctor = await loadDoctor(doctorId);
  const changed: AppointmentDocument[] = [];
  await mongoose.connection.transaction(async (session) => {
    changed.length = 0;
    const current = await findCurrent(doctor._id, session);
    if (current) {
      applyTransition(current, "completed", actor);
      await current.save({ session });
      await mongoose.model("Patient").updateOne({ _id: current.patient }, { $set: { lastVisitDate: current.date } }, { session });
      changed.push(current);
    }
    const waiting = (await AppointmentModel.find({ doctor: doctor._id, date: today(), status: "checked_in" }).session(session)) as AppointmentDocument[];
    const next = waiting.sort(compareQueue)[0];
    if (next) {
      applyTransition(next, "in_consultation", actor);
      await next.save({ session });
      changed.push(next);
    }
    if (!current && !next) throw new AppError(409, "Nobody is waiting. Check in patients at reception first.", "CONFLICT");
  });
  await afterQueueChange(changed, actor, "call_next");
  return getDoctorQueue(doctorId);
};

/** Call a specific waiting patient out of order (e.g. a report review), finishing the current one */
export const callSpecific = async (doctorId: string, appointmentId: string, actor: Actor) => {
  const doctor = await loadDoctor(doctorId);
  const changed: AppointmentDocument[] = [];
  await mongoose.connection.transaction(async (session) => {
    changed.length = 0;
    const target = await appointmentService.loadAppointment(appointmentId, session);
    if (String(target.doctor) !== String(doctor._id) || target.date !== today()) throw new AppError(404, "That patient is not in this doctor's queue today.");
    if (target.status !== "checked_in") throw new AppError(409, "Only a checked-in (waiting) patient can be called.", "CONFLICT");
    const current = await findCurrent(doctor._id, session);
    if (current) {
      applyTransition(current, "completed", actor);
      await current.save({ session });
      await mongoose.model("Patient").updateOne({ _id: current.patient }, { $set: { lastVisitDate: current.date } }, { session });
      changed.push(current);
    }
    applyTransition(target, "in_consultation", actor, "called out of order");
    await target.save({ session });
    changed.push(target);
  });
  await afterQueueChange(changed, actor, "call_specific");
  return getDoctorQueue(doctorId);
};

/** Announce the current serial again on the TV (patient did not hear it) */
export const recall = async (doctorId: string, actor: Actor) => {
  const doctor = await loadDoctor(doctorId);
  const current = (await AppointmentModel.findOne({ doctor: doctor._id, date: today(), status: "in_consultation" })) as AppointmentDocument | null;
  if (!current) throw new AppError(409, "Nobody is with the doctor right now.", "CONFLICT");
  current.calledAt = new Date();
  await current.save();
  await recordAudit({ req: actor.req, action: "UPDATE", entityType: "Appointment", entityId: current._id, meta: { queueAction: "recall", serialNo: current.serialNo } });
  notifyRecall({ doctorId: String(doctor._id), serialNo: current.serialNo, roomNo: doctor.roomNo });
  return getDoctorQueue(doctorId);
};

/** The patient stepped out (e.g. for a test): back to the waiting list, keeping their serial */
export const sendBack = async (appointmentId: string, actor: Actor, scopeDoctorId?: string) => {
  const appt = await appointmentService.loadAppointment(appointmentId);
  const doctorId = String(appt.doctor); // read before populate() replaces the id with the document
  if (scopeDoctorId && doctorId !== scopeDoctorId) throw new AppError(404, "That patient is not in your queue.");
  if (appt.status !== "in_consultation") throw new AppError(409, "Only the patient currently with the doctor can be sent back.", "CONFLICT");
  applyTransition(appt, "checked_in", actor, "sent back to waiting");
  await appt.save();
  await afterQueueChange([appt], actor, "send_back");
  return getDoctorQueue(doctorId);
};

export const queueService = { getDoctorQueue, getTodayBoard, callNext, callSpecific, recall, sendBack, compareQueue };
