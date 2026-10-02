/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHmac, randomBytes, randomInt, timingSafeEqual } from "crypto";
import { Request } from "express";
import mongoose, { Model, Schema, Types } from "mongoose";
import { env } from "../../config/env";
import AppError from "../../errors/AppError";
import { ageOn, todayInDhaka, nowMinutesInDhaka, toMinutes } from "../../utils/date";
import { toE164Bd } from "../../utils/phone";
import { deliverCode, maskPhone } from "../assistant/otp.service";
import { hashPassword, signInVerified } from "../auth/auth.service";
import { InvoiceModel } from "../billing/invoice.model";
import { LabOrderModel } from "../clinical/lab/labOrder.model";
import { VisitModel } from "../clinical/visits/visit.model";
import { AppointmentModel } from "../hospital/appointment/appointment.model";
import { bookAppointment, cancelAppointment, estimateFee } from "../hospital/appointment/appointment.service";
import { DoctorModel } from "../hospital/doctor/doctor.model";
import { getAvailabilityCalendar, getDoctorSlots } from "../hospital/scheduling/scheduling.service";
import { getSettings } from "../hospital/settings/settings.service";
import { PatientModel } from "../patients/patient.model";
import { noteFailedLogin } from "../security/security.service";
import { UserModel } from "../users/user.model";

/**
 * PATIENT PORTAL — a patient's OWN records, nothing else.
 *
 * Sign-in: the phone number registered at the hospital + a 6-digit code sent to it (WhatsApp).
 * The first sign-in creates a "patient" user for that number. Families share a phone, so one sign-in
 * sees every patient registered with that number (the same rule the chat assistant uses).
 * Every request is checked against that list — object-level authorization on every id.
 */

// ------------------------------------------------------------------ sign-in codes

const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_PER_HOUR = 3;
const RESEND_SECONDS = 60;

interface IPortalCode {
  phone: string;
  codeHash: string;
  attempts: number;
  usedAt: Date | null;
  expiresAt: Date;
  deliveredVia: string | null;
}
const PortalCodeSchema = new Schema<IPortalCode>(
  {
    phone: { type: String, required: true, index: true },
    codeHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    usedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
    deliveredVia: { type: String, default: null },
  },
  { timestamps: true },
);
PortalCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 }); // kept an hour for the per-hour limit
const PortalCodeModel: Model<IPortalCode> =
  mongoose.models.PortalCode || mongoose.model<IPortalCode>("PortalCode", PortalCodeSchema);

const hashCode = (phone: string, code: string) =>
  createHmac("sha256", env.JWT_SECRET_KEY).update(`portal:${phone}:${code}`).digest("hex");

const normalizePhone = (input: string) => {
  const phone = toE164Bd(input);
  if (!phone) throw new AppError(400, "Enter a valid Bangladeshi mobile number (01XXXXXXXXX).", "VALIDATION_ERROR");
  return phone;
};

/** Patients registered with this phone (main or alternative number) */
const patientsForPhone = (phone: string) =>
  PatientModel.find({ $or: [{ phone }, { altPhone: phone }] })
    .sort({ createdAt: 1 })
    .lean<any[]>();

export const requestCode = async (phoneInput: string) => {
  const phone = normalizePhone(phoneInput);
  if (!(await patientsForPhone(phone)).length)
    throw new AppError(
      404,
      "No patient is registered with this number. Please register at the reception desk or through the Testo Life chat.",
      "NOT_FOUND",
    );
  const recent = await PortalCodeModel.find({ phone, createdAt: { $gte: new Date(Date.now() - 3600_000) } })
    .sort({ createdAt: -1 })
    .lean<any[]>();
  if (recent.length >= MAX_PER_HOUR)
    throw new AppError(429, "Too many codes for this number. Please try again in an hour.", "RATE_LIMITED");
  if (recent[0] && Date.now() - new Date(recent[0].createdAt).getTime() < RESEND_SECONDS * 1000)
    throw new AppError(429, "A code was just sent. Please wait a minute before asking again.", "RATE_LIMITED");

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const deliveredVia = await deliverCode(phone, code);
  if (!deliveredVia) throw new AppError(503, "We could not send the code right now. Please try again shortly.");
  await PortalCodeModel.create({
    phone,
    codeHash: hashCode(phone, code),
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
    deliveredVia,
  });
  return {
    phoneMasked: maskPhone(phone),
    deliveredVia,
    resendAfterSeconds: RESEND_SECONDS,
    // Development only: lets a demo sign in without WhatsApp (never in production)
    ...(env.NODE_ENV !== "production" && deliveredVia === "log" ? { devCode: code } : {}),
  };
};

export const verifyCode = async (req: Request, phoneInput: string, code: string) => {
  const phone = normalizePhone(phoneInput);
  const v = await PortalCodeModel.findOne({ phone, usedAt: null, expiresAt: { $gt: new Date() } }).sort({
    createdAt: -1,
  });
  if (!v) throw new AppError(400, "No active code. Please ask for a new code.", "VALIDATION_ERROR");
  if (v.attempts >= MAX_ATTEMPTS)
    throw new AppError(429, "Too many wrong attempts. Please ask for a new code.", "RATE_LIMITED");
  v.attempts += 1;
  const given = Buffer.from(hashCode(phone, code.trim()));
  if (given.length !== v.codeHash.length || !timingSafeEqual(given, Buffer.from(v.codeHash))) {
    await v.save();
    noteFailedLogin(req.ip);
    throw new AppError(
      400,
      `The code is not correct. ${MAX_ATTEMPTS - v.attempts} attempt(s) left.`,
      "VALIDATION_ERROR",
    );
  }
  v.usedAt = new Date();
  await v.save();

  const patients = await patientsForPhone(phone);
  if (!patients.length) throw new AppError(404, "No patient is registered with this number.", "NOT_FOUND");
  const local = phone.replace("+88", "");
  let user = await UserModel.findOne({ role: "patient", phone: { $in: [phone, local] } });
  if (!user) {
    // First sign-in: a portal account for this number (no password — codes only)
    user = await UserModel.create({
      name: patients[0].name,
      email: `p${phone.replace(/\D/g, "")}@portal.testolife.local`,
      phone,
      role: "patient",
      passwordHash: await hashPassword(randomBytes(32).toString("hex")),
      isActive: true,
    });
  }
  return signInVerified(user, req, "phone_code");
};

// ------------------------------------------------------------------ whose records

/** The patients the signed-in user may see. Throws if the account has no phone or no patients. */
export const myPatients = async (req: Request) => {
  const user = await UserModel.findById(req.user!.id).select("phone").lean<any>();
  const phone = user?.phone ? toE164Bd(user.phone) : null;
  const patients = phone ? await patientsForPhone(phone) : [];
  if (!patients.length)
    throw new AppError(
      404,
      "No patient record is linked to this account. Please contact the reception desk.",
      "NOT_FOUND",
    );
  return patients;
};

const ownership = async (req: Request) => {
  const patients = await myPatients(req);
  const ids = new Set(patients.map((p) => String(p._id)));
  const check = (patientId: string) => {
    // 404, not 403: never confirm that someone else's record exists
    if (!ids.has(String(patientId))) throw new AppError(404, "Not found.");
  };
  return { patients, ids, check };
};

const patientView = (p: any) => ({
  id: String(p._id),
  name: p.name,
  nameBn: p.nameBn ?? null,
  patientCode: p.patientCode,
  age: ageOn(p.dateOfBirth),
  gender: p.gender,
});
const doctorName = (d: any) => (d ? `${d.title ?? ""} ${d.name}`.trim() : "");

export const me = async (req: Request) => {
  const patients = await myPatients(req);
  const settings = await getSettings();
  return {
    patients: patients.map(patientView),
    hospital: {
      name: settings.name,
      nameBn: settings.nameBn,
      emergencyPhone: settings.emergencyPhone,
      phones: settings.phones,
      openingHours: settings.openingHours,
      openingHoursBn: settings.openingHoursBn,
      address: settings.address,
    },
    cancellationCutoffMinutes: settings.cancellationCutoffMinutes,
    bookingWindowDays: settings.bookingWindowDays,
  };
};

// ------------------------------------------------------------------ appointments

const ACTIVE = ["booked", "checked_in", "in_consultation"];

export const appointments = async (req: Request) => {
  const { ids } = await ownership(req);
  const { cancellationCutoffMinutes } = await getSettings();
  const today = todayInDhaka();
  const rows = await AppointmentModel.find({ patient: { $in: [...ids] } })
    .sort({ date: -1, slotTime: -1 })
    .limit(60)
    .populate("patient", "name nameBn")
    .populate({
      path: "doctor",
      select: "title name roomNo department",
      populate: { path: "department", select: "name nameBn" },
    })
    .lean<any[]>();
  const view = (a: any) => {
    const minutesLeft =
      a.date === today ? toMinutes(a.slotTime) - nowMinutesInDhaka() : a.date > today ? Infinity : -Infinity;
    return {
      id: String(a._id),
      patient: { id: String(a.patient._id), name: a.patient.name, nameBn: a.patient.nameBn ?? null },
      doctor: doctorName(a.doctor),
      department: a.doctor?.department?.name ?? "",
      departmentBn: a.doctor?.department?.nameBn ?? "",
      roomNo: a.doctor?.roomNo ?? null,
      date: a.date,
      slotTime: a.slotTime,
      serialNo: a.serialNo,
      status: a.status,
      fee: a.feeSnapshot ?? null,
      source: a.source,
      canCancel: a.status === "booked" && minutesLeft >= cancellationCutoffMinutes,
    };
  };
  return {
    upcoming: rows
      .filter((a) => a.date >= today && ACTIVE.includes(a.status))
      .map(view)
      .reverse(),
    past: rows.filter((a) => !(a.date >= today && ACTIVE.includes(a.status))).map(view),
  };
};

/** Doctors patients can book: active, with department, fee and the next free day */
export const doctors = async () => {
  const list = await DoctorModel.find({ isActive: true })
    .populate("department", "name nameBn")
    .sort({ name: 1 })
    .lean<any[]>();
  return list.map((d) => ({
    id: String(d._id),
    name: doctorName(d),
    nameBn: d.nameBn ?? null,
    degrees: d.degrees ?? "",
    specialization: d.specialization ?? "",
    department: d.department?.name ?? "",
    departmentBn: d.department?.nameBn ?? "",
    consultationFee: d.consultationFee,
    followUpFee: d.followUpFee,
    photoUrl: d.photoUrl ?? null,
    days: [...new Set((d.sessions ?? []).map((s: any) => s.dayOfWeek))].sort(),
  }));
};

export const availability = (doctorId: string) => getAvailabilityCalendar(doctorId, 14);
export const slots = async (doctorId: string, date: string) => {
  const day = await getDoctorSlots(doctorId, date);
  return {
    date: day.date,
    onLeave: day.onLeave,
    leaveReason: day.leaveReason ?? null,
    sessions: day.sessions,
    slots: day.slots.filter((s) => s.available).map((s) => ({ time: s.time, sessionLabel: s.sessionLabel })),
  };
};

export const quote = async (req: Request, patientId: string, doctorId: string, date: string) => {
  const { check } = await ownership(req);
  check(patientId);
  const doctor = await DoctorModel.findById(doctorId).lean<any>();
  if (!doctor || !doctor.isActive) throw new AppError(404, "Doctor not found.");
  return estimateFee(patientId, doctor, date);
};

export const book = async (
  req: Request,
  input: { patientId: string; doctorId: string; date: string; slotTime: string },
) => {
  const { check } = await ownership(req);
  check(input.patientId);
  const appt = await bookAppointment({ ...input, source: "portal" }, { req, label: "patient portal" });
  return {
    id: appt.id,
    date: appt.date,
    slotTime: appt.slotTime,
    serialNo: appt.serialNo,
    doctor: appt.doctor.displayName,
    status: appt.status,
  };
};

export const cancel = async (req: Request, appointmentId: string, reason: string) => {
  const { check } = await ownership(req);
  if (!Types.ObjectId.isValid(appointmentId)) throw new AppError(404, "Not found.");
  const a = await AppointmentModel.findById(appointmentId).select("patient status").lean<any>();
  if (!a) throw new AppError(404, "Not found.");
  check(String(a.patient));
  if (a.status !== "booked")
    throw new AppError(409, "Only a booked appointment can be cancelled here. Please call the hospital.", "CONFLICT");
  const { cancellationCutoffMinutes } = await getSettings();
  await cancelAppointment(
    appointmentId,
    `Cancelled by the patient: ${reason}`,
    { req, label: "patient portal" },
    { enforceCutoffMinutes: cancellationCutoffMinutes },
  );
  return { id: appointmentId, status: "cancelled" };
};

// ------------------------------------------------------------------ prescriptions, reports, bills

export const prescriptions = async (req: Request) => {
  const { ids } = await ownership(req);
  const visits = await VisitModel.find({ patient: { $in: [...ids] }, status: "closed", prescriptionNo: { $ne: null } })
    .sort({ date: -1 })
    .limit(50)
    .populate("patient", "name nameBn")
    .populate({ path: "doctor", select: "title name department", populate: { path: "department", select: "name" } })
    .lean<any[]>();
  return visits.map((v) => ({
    id: String(v._id),
    prescriptionNo: v.prescriptionNo,
    date: v.date,
    patient: { id: String(v.patient._id), name: v.patient.name },
    doctor: doctorName(v.doctor),
    department: v.doctor?.department?.name ?? "",
    diagnosis: v.finalDiagnosis || v.provisionalDiagnosis || "",
    medicines: (v.prescription ?? []).map((p: any) => ({
      brandName: p.brandName,
      strength: p.strength ?? "",
      form: p.form ?? "",
      dosePattern: p.dosePattern,
      durationDays: p.durationDays ?? null,
      continued: Boolean(p.continued),
      instructionsBn: p.instructionsBn ?? "",
      instructionsEn: p.instructionsEn ?? "",
    })),
    adviceBn: v.adviceBn ?? "",
    adviceEn: v.adviceEn ?? "",
    followUpDate: v.followUp?.date ?? null,
  }));
};

const LAB_STAGE: Record<string, string> = {
  ordered: "Waiting for sample",
  sample_collected: "Sample collected",
  processing: "Being tested",
  awaiting_verification: "Being checked",
  ready: "Ready",
  delivered: "Ready",
};

export const reports = async (req: Request) => {
  const { ids } = await ownership(req);
  const orders = await LabOrderModel.find({ patient: { $in: [...ids] }, status: { $ne: "cancelled" } })
    .sort({ createdAt: -1 })
    .limit(50)
    .populate("patient", "name")
    .lean<any[]>();
  return orders.map((o) => ({
    id: String(o._id),
    orderNo: o.orderNo,
    date: o.date,
    patient: { id: String(o.patient._id), name: o.patient.name },
    tests: (o.tests ?? []).map((t: any) => t.name),
    ready: ["ready", "delivered"].includes(o.status),
    stage: LAB_STAGE[o.status] ?? o.status,
    verifiedAt: o.verifiedAt ?? null,
  }));
};

export const bills = async (req: Request) => {
  const { ids } = await ownership(req);
  const invoices = await InvoiceModel.find({ patient: { $in: [...ids] }, status: { $nin: ["draft", "void"] } })
    .sort({ date: -1 })
    .limit(50)
    .populate("patient", "name")
    .lean<any[]>();
  const today = todayInDhaka();
  return invoices.map((i) => ({
    id: String(i._id),
    invoiceNo: i.invoiceNo,
    date: i.date,
    dueDate: i.dueDate,
    patient: { id: String(i.patient._id), name: i.patient.name },
    items: (i.items ?? []).map((l: any) => l.description),
    total: i.total,
    amountPaid: i.amountPaid,
    amountDue: i.amountDue,
    status: i.status,
    overdue: ["issued", "partial"].includes(i.status) && i.dueDate < today,
  }));
};

/** Throws 404 unless the document belongs to one of the caller's patients */
export const ownerCheckFor = async (req: Request) => (await ownership(req)).check;

export const invoiceOwner = async (req: Request, invoiceId: string) => {
  const check = await ownerCheckFor(req);
  if (!Types.ObjectId.isValid(invoiceId)) throw new AppError(404, "Not found.");
  const inv = await InvoiceModel.findById(invoiceId).select("patient").lean<any>();
  if (!inv) throw new AppError(404, "Not found.");
  check(String(inv.patient));
};
