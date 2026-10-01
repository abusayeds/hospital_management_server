/* eslint-disable @typescript-eslint/no-explicit-any */
import { Types } from "mongoose";
import { AppointmentModel } from "../../hospital/appointment/appointment.model";
import type { HospitalSettings } from "../../hospital/settings/settings.service";
import { PatientModel } from "../../patients/patient.model";

/**
 * Helpers the rules share. Variables carry FIRST names, doctor names, dates and serials only —
 * never diagnoses, medicines, lab values or anyone else's details.
 */

export type Lang = "bn" | "en";

export const firstName = (name?: string | null) =>
  String(name ?? "")
    .trim()
    .split(/\s+/)[0] ?? "";

export const languageOf = (patient: any): Lang => (patient?.preferences?.language === "en" ? "en" : "bn");

export const doctorNameFor = (doctor: any, lang: Lang) => {
  const en = `${doctor?.title ?? "Dr."} ${doctor?.name ?? ""}`.trim();
  return lang === "bn" && doctor?.nameBn ? doctor.nameBn : en;
};

export const hospitalNameFor = (s: HospitalSettings, lang: Lang) => (lang === "bn" ? s.nameBn || s.name : s.name);

export const hospitalPhone = (s: HospitalSettings) => s.phones?.[0] ?? s.emergencyPhone;

/** An appointment with its patient (contact + preferences) and doctor, or null */
export const loadAppointment = async (id: string) => {
  if (!Types.ObjectId.isValid(id)) return null;
  return AppointmentModel.findById(id)
    .populate("patient", "name nameBn phone preferences")
    .populate("doctor", "title name nameBn roomNo leaves")
    .lean<any>();
};

export const loadPatient = (id: unknown) =>
  PatientModel.findById(id).select("name nameBn phone preferences dateOfBirth").lean<any>();

/** The common variables of every appointment message */
export const appointmentVariables = (a: any, s: HospitalSettings, lang: Lang) => ({
  patientName: firstName(lang === "bn" && a.patient?.nameBn ? a.patient.nameBn : a.patient?.name),
  doctorName: doctorNameFor(a.doctor, lang),
  date: a.date,
  time: a.slotTime,
  serial: String(a.serialNo),
  room: a.doctor?.roomNo ?? "",
  fee: String(Math.round((a.feeSnapshot ?? 0) / 100)),
  hospital: hospitalNameFor(s, lang),
});

/** The standard "send to this appointment's patient" result for prepare() */
export const toAppointmentPatient = (a: any, variables: Record<string, unknown>, lang: Lang) => ({
  ok: true as const,
  to: "patient" as const,
  patientId: String(a.patient._id),
  phone: a.patient.phone as string,
  language: lang,
  variables,
  buttonRef: String(a._id),
  related: { type: "appointment" as const, id: String(a._id) },
});

export const fail = (reason: string) => ({ ok: false as const, reason });
