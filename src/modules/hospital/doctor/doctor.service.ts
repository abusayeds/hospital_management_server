/* eslint-disable @typescript-eslint/no-explicit-any */
import { Request } from "express";
import mongoose, { Types } from "mongoose";
import AppError from "../../../errors/AppError";
import { buildPagination } from "../../../interface/global.interface";
import { DAY_NAMES_EN, isValidDateString, todayInDhaka, weekdayOf } from "../../../utils/date";
import { escapeRegex } from "../../../utils/escapeRegex";
import { formatTaka } from "../../../utils/money";
import { serialize } from "../../../utils/serialize";
import { recordAudit } from "../../audit/audit.service";
import { UserModel } from "../../users/user.model";
import { DepartmentModel } from "../department/department.model";
import { findLeave, sessionKeyOf, validateSessions } from "../scheduling/slotEngine";
import { DoctorModel } from "./doctor.model";

// "Sat 09:00-13:00, Sat 17:00-20:00, Mon 09:00-13:00" (week starts on Saturday in Bangladesh)
export const describeSchedule = (sessions: { dayOfWeek: number; startTime: string; endTime: string }[]): string =>
  [...sessions]
    .sort((a, b) => ((a.dayOfWeek + 1) % 7) - ((b.dayOfWeek + 1) % 7) || a.startTime.localeCompare(b.startTime))
    .map((s) => `${DAY_NAMES_EN[s.dayOfWeek].slice(0, 3)} ${s.startTime}-${s.endTime}`)
    .join(", ");

/** Does the doctor sit on `date`? (schedule + leave only; bookings are the slot engine's job) */
export const availabilityOn = (doctor: any, date: string) => {
  const leave = findLeave(doctor.leaves ?? [], date);
  const sessions = (doctor.sessions ?? [])
    .filter((s: any) => s.dayOfWeek === weekdayOf(date))
    .sort((a: any, b: any) => a.startTime.localeCompare(b.startTime))
    .map((s: any) => ({ sessionKey: sessionKeyOf(s), startTime: s.startTime, endTime: s.endTime }));
  return {
    date,
    onLeave: Boolean(leave),
    leaveReason: leave?.reason,
    sits: !leave && sessions.length > 0,
    sessions: leave ? [] : sessions,
  };
};

/**
 * The one shape of a doctor in API responses (and, in Phase 5, chatbot answers).
 * Department must be populated. `withAccount` adds the linked login (admin screens only).
 */
export const toDoctorSummary = (doctor: any, { withAccount = false } = {}) => ({
  id: String(doctor._id),
  title: doctor.title,
  name: doctor.name,
  nameBn: doctor.nameBn,
  displayName: `${doctor.title ? doctor.title + " " : ""}${doctor.name}`,
  department: doctor.department?._id
    ? { id: String(doctor.department._id), name: doctor.department.name, nameBn: doctor.department.nameBn }
    : { id: String(doctor.department), name: "", nameBn: "" },
  degrees: doctor.degrees,
  specialization: doctor.specialization,
  consultationFee: doctor.consultationFee,
  followUpFee: doctor.followUpFee,
  followUpValidDays: doctor.followUpValidDays,
  consultationFeeText: formatTaka(doctor.consultationFee),
  maxPatientsPerSession: doctor.maxPatientsPerSession,
  averageMinutesPerPatient: doctor.averageMinutesPerPatient,
  roomNo: doctor.roomNo,
  photoUrl: doctor.photoUrl,
  bio: doctor.bio,
  languages: doctor.languages,
  isActive: doctor.isActive,
  sessions: doctor.sessions,
  leaves: (doctor.leaves ?? []).filter((l: any) => l.to >= todayInDhaka()), // past leaves are history
  scheduleText: describeSchedule(doctor.sessions ?? []),
  today: availabilityOn(doctor, todayInDhaka()),
  ...(withAccount && {
    account: doctor.user?._id
      ? { id: String(doctor.user._id), name: doctor.user.name, email: doctor.user.email }
      : null,
  }),
});

const findOrThrow = async (id: string) => {
  const doc = await DoctorModel.findById(id).populate("department", "name nameBn").populate("user", "name email");
  if (!doc) throw new AppError(404, "Doctor not found.");
  return doc;
};

type ListFilters = {
  departmentId?: string;
  search?: string;
  availableOn?: string;
  status?: "active" | "inactive";
  page: number;
  limit: number;
};

export const listDoctors = async (f: ListFilters, { withAccount = false } = {}) => {
  const filter: Record<string, unknown> = {};
  filter.isActive = f.status ? f.status === "active" : true;
  if (f.departmentId) filter.department = f.departmentId;
  if (f.search) {
    const rx = new RegExp(escapeRegex(f.search), "i");
    filter.$or = [{ name: rx }, { nameBn: rx }, { specialization: rx }, { degrees: rx }];
  }
  if (f.availableOn) {
    if (!isValidDateString(f.availableOn)) throw new AppError(400, "availableOn must be YYYY-MM-DD.");
    // sits on that weekday AND no leave covering that date
    filter["sessions.dayOfWeek"] = weekdayOf(f.availableOn);
    filter.leaves = { $not: { $elemMatch: { from: { $lte: f.availableOn }, to: { $gte: f.availableOn } } } };
  }

  const [items, total] = await Promise.all([
    DoctorModel.find(filter)
      .populate("department", "name nameBn")
      .populate(withAccount ? { path: "user", select: "name email" } : [])
      .sort({ name: 1 })
      .skip((f.page - 1) * f.limit)
      .limit(f.limit),
    DoctorModel.countDocuments(filter),
  ]);
  return {
    items: items.map((d: any) => toDoctorSummary(d, { withAccount })),
    pagination: buildPagination(f.page, f.limit, total),
  };
};

export const getDoctor = async (id: string, { withAccount = false } = {}) =>
  toDoctorSummary(await findOrThrow(id), { withAccount });

type DoctorInput = Partial<Record<string, any>> & { department?: string; sessions?: any[]; leaves?: any[] };

const assertValidInput = async (input: DoctorInput) => {
  if (input.department && !(await DepartmentModel.exists({ _id: input.department, isActive: true }))) {
    throw new AppError(400, "Choose an active department.", "VALIDATION_ERROR", [
      { path: "body.department", message: "not found or inactive" },
    ]);
  }
  if (input.sessions) {
    const problems = validateSessions(input.sessions);
    if (problems.length) {
      throw new AppError(
        400,
        problems[0],
        "VALIDATION_ERROR",
        problems.map((message) => ({ path: "body.sessions", message })),
      );
    }
  }
};

// Snapshot for the audit log: the fields that matter, sessions and leaves included
const snapshot = (d: any) => {
  const s = serialize<Record<string, unknown>>(d);
  delete s.user;
  return s;
};

export const createDoctor = async (req: Request, input: DoctorInput) => {
  await assertValidInput(input);
  const doc = await DoctorModel.create({ ...input, createdBy: req.user!.id });
  await recordAudit({ req, action: "CREATE", entityType: "Doctor", entityId: doc._id, after: snapshot(doc) });
  return getDoctor(String(doc._id), { withAccount: true });
};

export const updateDoctor = async (req: Request, id: string, input: DoctorInput) => {
  await assertValidInput(input);
  const doc = await findOrThrow(id);
  const before = snapshot(doc);
  doc.set({ ...input, updatedBy: req.user!.id });
  await doc.save();
  await recordAudit({ req, action: "UPDATE", entityType: "Doctor", entityId: doc._id, before, after: snapshot(doc) });
  return getDoctor(id, { withAccount: true });
};

export const setDoctorActive = async (req: Request, id: string, active: boolean) => {
  const doc = await findOrThrow(id);
  if (doc.isActive !== active) {
    doc.isActive = active;
    doc.updatedBy = new Types.ObjectId(req.user!.id);
    await doc.save();
    await recordAudit({ req, action: active ? "ACTIVATE" : "DEACTIVATE", entityType: "Doctor", entityId: doc._id });
  }
  return getDoctor(id, { withAccount: true });
};

/**
 * Link a doctor profile to a login account (role "doctor"), or unlink with userId = null.
 * One-to-one: enforced here with a clear message AND by a unique index on Doctor.user.
 * Doctor.user and User.doctorProfile are updated together in one transaction.
 */
export const linkDoctorAccount = async (req: Request, doctorId: string, userId: string | null) => {
  const doctor = await findOrThrow(doctorId);
  const previousUserId = doctor.user?._id ? String(doctor.user._id) : null;

  if (userId) {
    const user = await UserModel.findById(userId);
    if (!user) throw new AppError(404, "User not found.");
    if (user.role !== "doctor")
      throw new AppError(400, "Only an account with the Doctor role can be linked.", "VALIDATION_ERROR");
    const other = await DoctorModel.findOne({ user: user._id, _id: { $ne: doctor._id } });
    if (other) throw new AppError(409, `This account is already linked to ${other.title} ${other.name}.`, "CONFLICT");
  }

  await mongoose.connection.transaction(async (session) => {
    if (previousUserId && previousUserId !== userId) {
      await UserModel.updateOne({ _id: previousUserId }, { $set: { doctorProfile: null } }, { session });
    }
    await DoctorModel.updateOne({ _id: doctor._id }, { $set: { user: userId, updatedBy: req.user!.id } }, { session });
    if (userId) await UserModel.updateOne({ _id: userId }, { $set: { doctorProfile: doctor._id } }, { session });
  });

  await recordAudit({
    req,
    action: "UPDATE",
    entityType: "Doctor",
    entityId: doctor._id,
    before: { linkedUser: previousUserId },
    after: { linkedUser: userId },
    meta: { change: userId ? "account_linked" : "account_unlinked" },
  });
  return getDoctor(doctorId, { withAccount: true });
};

/**
 * Free-text doctor search by department NAME (English or Bangla) and/or doctor name —
 * the shape a patient types. Used by the assistant chat (Phase 5 builds on it).
 */
export const searchDoctorsByText = async ({ department, name }: { department?: string; name?: string }) => {
  const filter: Record<string, unknown> = { isActive: true };
  if (department) {
    const rx = new RegExp(escapeRegex(department.trim()), "i");
    const ids = await DepartmentModel.find({ isActive: true, $or: [{ name: rx }, { nameBn: rx }] }).distinct("_id");
    filter.department = { $in: ids };
  }
  if (name) filter.name = new RegExp(escapeRegex(name.trim().replace(/^(dr\.?|ডা\.?)\s*/i, "")), "i");
  const doctors = await DoctorModel.find(filter).populate("department", "name nameBn").sort({ name: 1 }).limit(20);
  return doctors.map((d: any) => toDoctorSummary(d));
};

/** The doctor profile of the signed-in doctor (null if the account is not linked yet) */
export const findDoctorForUser = (userId: string) => DoctorModel.findOne({ user: userId });

export const doctorService = {
  listDoctors,
  getDoctor,
  createDoctor,
  updateDoctor,
  setDoctorActive,
  linkDoctorAccount,
  findDoctorForUser,
  toDoctorSummary,
  describeSchedule,
  availabilityOn,
};
