/* eslint-disable @typescript-eslint/no-explicit-any */
import AppError from "../../../errors/AppError";
import { ageOn } from "../../../utils/date";
import { AppointmentModel } from "../../hospital/appointment/appointment.model";
import { PatientModel } from "../../patients/patient.model";
import type { ConversationDocument } from "../conversation.model";
import { refFor, resolveRef } from "../refs";

/**
 * WHOSE RECORDS A CHAT MAY TOUCH — the heart of tool authorisation.
 *  - WhatsApp: the sender's number is proven by WhatsApp itself (`verifiedPhone`), so every patient
 *    and appointment on that number belongs to the chat.
 *  - Web: the visitor only TYPES a number (`phone`, no code). Anyone could type someone else's
 *    number, so the chat sees only the patients it added itself and the appointments it booked
 *    itself — never older records on that number.
 * A reference from the model is only a hint: the record is loaded and checked here, or the call fails.
 */
export const contactPhone = (conv: ConversationDocument) => conv.verifiedPhone ?? conv.phone ?? null;

const hasId = (ids: unknown[] | undefined, id: unknown) => (ids ?? []).some((x) => String(x) === String(id));

/** Database filter for the patients this chat may book for */
export const myPatientsFilter = (conv: ConversationDocument) =>
  conv.verifiedPhone ? { phone: conv.verifiedPhone } : { _id: { $in: conv.linkedPatientIds }, phone: conv.phone };

/** Database filter for the appointments this chat may see and change */
export const myAppointmentsFilter = (conv: ConversationDocument) =>
  conv.verifiedPhone ? { patient: { $in: conv.linkedPatientIds } } : { _id: { $in: conv.chatAppointmentIds ?? [] } };

/** May this chat act on an appointment (given the phone of the appointment's patient)? */
export const ownsAppointment = (conv: ConversationDocument, appointmentId: unknown, patientPhone: unknown) => {
  const phone = contactPhone(conv);
  if (!phone || patientPhone !== phone) return false;
  return Boolean(conv.verifiedPhone) || hasId(conv.chatAppointmentIds, appointmentId);
};

export const ownedPatient = async (conv: ConversationDocument, ref: unknown) => {
  const id = resolveRef(conv, "P", ref);
  if (!id) throw new AppError(400, "Unknown patient. Call list_my_patients and use its P-reference.");
  const phone = contactPhone(conv);
  const patient = phone ? await PatientModel.findOne({ _id: id, phone }) : null;
  if (!patient || (!conv.verifiedPhone && !hasId(conv.linkedPatientIds, id)))
    throw new AppError(403, "That patient was not added in this chat. Use register_patient first.", "FORBIDDEN");
  return patient as any;
};

export const ownedAppointment = async (conv: ConversationDocument, ref: unknown) => {
  const id = resolveRef(conv, "A", ref);
  if (!id) throw new AppError(400, "Unknown appointment. Call get_my_appointments and use its A-reference.");
  const appt = await AppointmentModel.findById(id)
    .populate("patient", "name phone")
    .populate("doctor", "title name roomNo");
  if (!appt || !ownsAppointment(conv, appt._id, (appt as any).patient?.phone))
    throw new AppError(403, "That appointment does not belong to this chat.", "FORBIDDEN");
  return appt as any;
};

/** Appointment / patient source for bookings made by the assistant */
export const sourceOf = (conv: ConversationDocument): "whatsapp" | "chatbot" =>
  conv.channel === "whatsapp" ? "whatsapp" : "chatbot";

export const firstName = (name: string) => String(name).trim().split(/\s+/)[0];

/** What the model may know about a patient: reference, first name, age, gender */
export const patientForModel = (conv: ConversationDocument, p: any) => ({
  ref: refFor(conv, "P", String(p._id)),
  firstName: firstName(p.name),
  age: ageOn(p.dateOfBirth),
  gender: p.gender,
});

export const maskCode = (code: string) => `${code.slice(0, 3)}•••${code.slice(-2)}`;

export const time12 = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

export const dateLabel = (date: string) =>
  new Date(`${date}T00:00:00+06:00`).toLocaleDateString("en-GB", {
    timeZone: "Asia/Dhaka",
    weekday: "short",
    day: "numeric",
    month: "short",
  });

export const taka = (poisha: number) => `৳${Math.round(poisha / 100).toLocaleString("en-IN")}`;
