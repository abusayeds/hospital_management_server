/* eslint-disable @typescript-eslint/no-explicit-any */
import AppError from "../../../errors/AppError";
import { todayInDhaka } from "../../../utils/date";
import { formatTaka } from "../../../utils/money";
import { normalizeBdPhone } from "../../../utils/phone";
import { bookAppointment } from "../../hospital/appointment/appointment.service";
import { AppointmentModel } from "../../hospital/appointment/appointment.model";
import { getDoctorSlots } from "../../hospital/scheduling/scheduling.service";
import { createPatient, findPossibleDuplicates } from "../../patients/patient.service";

/**
 * Thin adapter between the assistant's tools and the Phase 3 services. The assistant
 * books through the SAME booking service as reception (same rules, serials, audit and
 * realtime events). The full chatbot, knowledge base and WhatsApp arrive in Phase 5.
 */

/** Free slots in a compact form the language model can read easily */
export const assistantSlots = async (doctorId: string, date: string) => {
  const day = await getDoctorSlots(doctorId, date);
  return {
    date: day.date,
    onLeave: day.onLeave,
    leaveReason: day.leaveReason,
    sittings: day.sessions.map((s) => ({ session: s.label, from: s.startTime, to: s.endTime, seatsLeft: s.remaining })),
    availableTimes: day.slots
      .filter((s) => s.available)
      .map((s) => s.time)
      .slice(0, 24),
    message: day.onLeave
      ? "The doctor is on leave that day."
      : day.sessions.length === 0
        ? "The doctor does not sit that day."
        : day.availableCount === 0
          ? "No free slots that day."
          : undefined,
  };
};

/**
 * Find the patient by phone + look-alike name (families share phones), or register them
 * with registrationSource "chatbot". Then book with source "chatbot".
 */
export const assistantBook = async (args: any, chatSessionId: string) => {
  const phone = normalizeBdPhone(String(args.phone ?? ""));
  const name = String(args.patient_name ?? "").trim();
  if (name.length < 2) throw new AppError(400, "Patient name is required.");

  const [existing] = await findPossibleDuplicates(phone, name);
  const patient =
    existing ??
    (await createPatient(
      {
        name,
        phone,
        gender: ["male", "female", "other"].includes(args.gender) ? args.gender : "other",
        ageYears: Number(args.age) || 0,
        registrationSource: "chatbot",
      },
      { allowDuplicate: true },
    ));

  const a = await bookAppointment({
    patientId: String(patient._id),
    doctorId: String(args.doctor_id),
    date: String(args.date),
    slotTime: args.slot_time ? String(args.slot_time) : undefined,
    source: "chatbot",
    notes: args.reason ? String(args.reason).slice(0, 500) : undefined,
    chatSessionId,
  });

  // Only what the patient needs to hear back
  return {
    id: a.id,
    patientCode: a.patient.patientCode,
    patientName: a.patient.name,
    doctor: a.doctor.displayName,
    department: a.department.name,
    room: a.doctor.roomNo,
    date: a.date,
    slotTime: a.slotTime,
    serialNo: a.serialNo,
    fee: formatTaka(a.fee),
    visitType: a.type === "follow_up" ? "follow-up" : "new",
  };
};

/**
 * Upcoming appointments for the patient in THIS chat. Requires phone AND a matching
 * name, and never returns other family members' names or phone numbers.
 */
export const assistantFindAppointments = async (rawPhone: string, name: string) => {
  const phone = normalizeBdPhone(String(rawPhone ?? ""));
  const matches = await findPossibleDuplicates(phone, String(name ?? ""));
  if (!matches.length) return { appointments: [], message: "No patient with that name on this number." };
  const appts = await AppointmentModel.find({
    patient: { $in: matches.map((m: any) => m._id) },
    date: { $gte: todayInDhaka() },
    holdsSlot: true,
  })
    .populate("doctor", "title name roomNo")
    .sort({ date: 1, slotTime: 1 })
    .limit(10);
  return {
    appointments: appts.map((a: any) => ({
      doctor: `${a.doctor?.title ?? ""} ${a.doctor?.name ?? ""}`.trim(),
      room: a.doctor?.roomNo,
      date: a.date,
      time: a.slotTime,
      serialNo: a.serialNo,
      status: a.status,
    })),
  };
};
