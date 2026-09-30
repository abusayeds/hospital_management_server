/* eslint-disable @typescript-eslint/no-explicit-any */
import AppError from "../../../errors/AppError";
import { ageOn } from "../../../utils/date";
import { AppointmentModel } from "../../hospital/appointment/appointment.model";
import { PatientModel } from "../../patients/patient.model";
import type { ConversationDocument } from "../conversation.model";
import { refFor, resolveRef } from "../refs";

/**
 * OWNERSHIP CHECKS — the heart of tool authorisation. A reference from the model is only a hint:
 * the record is loaded and must belong to the conversation's VERIFIED phone, or the call fails.
 */
export const ownedPatient = async (conv: ConversationDocument, ref: unknown) => {
  const id = resolveRef(conv, "P", ref);
  if (!id) throw new AppError(400, "Unknown patient. Call list_my_patients and use its P-reference.");
  const patient = await PatientModel.findOne({ _id: id, phone: conv.verifiedPhone });
  if (!patient) throw new AppError(403, "That patient is not linked to the verified phone number.", "FORBIDDEN");
  return patient as any;
};

export const ownedAppointment = async (conv: ConversationDocument, ref: unknown) => {
  const id = resolveRef(conv, "A", ref);
  if (!id) throw new AppError(400, "Unknown appointment. Call get_my_appointments and use its A-reference.");
  const appt = await AppointmentModel.findById(id)
    .populate("patient", "name phone")
    .populate("doctor", "title name roomNo");
  if (!appt || (appt as any).patient?.phone !== conv.verifiedPhone)
    throw new AppError(403, "That appointment does not belong to the verified phone number.", "FORBIDDEN");
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
