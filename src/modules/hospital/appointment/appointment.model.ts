import mongoose, { HydratedDocument, Schema, Types } from "mongoose";
import { basePlugin, IBaseFields, IBaseMethods } from "../../../models/plugins/basePlugin";
import { DATE_PATTERN, TIME_PATTERN } from "../../../utils/date";

export const APPOINTMENT_STATUSES = [
  "booked", // booked, patient not arrived yet
  "checked_in", // arrived, waiting in the queue
  "in_consultation", // with the doctor now
  "completed",
  "cancelled",
  "no_show",
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

// Statuses that occupy a slot. Kept in sync with the `holdsSlot` flag below.
export const ACTIVE_STATUSES: readonly AppointmentStatus[] = ["booked", "checked_in", "in_consultation"];

export const APPOINTMENT_SOURCES = ["reception", "chatbot", "whatsapp", "phone", "walk_in"] as const;
export type AppointmentSource = (typeof APPOINTMENT_SOURCES)[number];

export const PRIORITIES = ["normal", "elderly", "emergency"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_RANK: Record<Priority, number> = { emergency: 0, elderly: 1, normal: 2 };

export type StatusChange = { status: AppointmentStatus; at: Date; by?: Types.ObjectId | null; note?: string };

export interface IAppointment extends IBaseFields {
  patient: Types.ObjectId;
  doctor: Types.ObjectId;
  department: Types.ObjectId; // snapshot: the doctor's department when booked
  date: string; // YYYY-MM-DD, hospital local time (Asia/Dhaka)
  slotTime: string; // HH:mm
  sessionKey: string; // "09:00-13:00" — which sitting of the day
  serialNo: number; // per doctor + date + session, from an atomic counter
  type: "new" | "follow_up";
  feeSnapshot: number; // poisha, the fee that applied at booking time
  source: AppointmentSource;
  status: AppointmentStatus;
  priority: Priority;
  // true while status is booked / checked_in / in_consultation. Both unique indexes
  // below only cover rows where it is true, so cancelled rows never block a slot.
  holdsSlot: boolean;
  statusHistory: StatusChange[];
  checkedInAt?: Date | null;
  calledAt?: Date | null; // last time the doctor called / recalled this serial
  consultationStartedAt?: Date | null;
  completedAt?: Date | null;
  cancelledAt?: Date | null;
  cancelReason?: string | null;
  notes?: string;
  rescheduledFrom?: Types.ObjectId | null;
  rescheduledTo?: Types.ObjectId | null;
  chatSessionId?: string | null;
  // Automation (Phase 6)
  confirmedByPatient: boolean; // the patient tapped "Confirm" on a confirmation / reminder
  confirmedAt?: Date | null;
  lastReminderSentAt?: Date | null;
  doctorAbsent: boolean; // the doctor took leave after this booking → reception sees it highlighted
  doctorAbsentNotifiedAt?: Date | null;
}

export type AppointmentDocument = HydratedDocument<IAppointment, IBaseMethods>;

const StatusChangeSchema = new Schema<StatusChange>(
  {
    status: { type: String, enum: APPOINTMENT_STATUSES, required: true },
    at: { type: Date, required: true },
    by: { type: Schema.Types.ObjectId, ref: "User", default: null },
    note: { type: String, maxlength: 300 },
  },
  { _id: false },
);

const AppointmentSchema = new Schema<IAppointment>({
  patient: { type: Schema.Types.ObjectId, ref: "Patient", required: true },
  doctor: { type: Schema.Types.ObjectId, ref: "Doctor", required: true },
  department: { type: Schema.Types.ObjectId, ref: "Department", required: true },
  date: { type: String, required: true, match: DATE_PATTERN },
  slotTime: { type: String, required: true, match: TIME_PATTERN },
  sessionKey: { type: String, required: true },
  serialNo: { type: Number, required: true, min: 1 },
  type: { type: String, enum: ["new", "follow_up"], default: "new" },
  feeSnapshot: { type: Number, required: true, min: 0 },
  source: { type: String, enum: APPOINTMENT_SOURCES, default: "reception" },
  status: { type: String, enum: APPOINTMENT_STATUSES, default: "booked" },
  priority: { type: String, enum: PRIORITIES, default: "normal" },
  holdsSlot: { type: Boolean, default: true },
  statusHistory: { type: [StatusChangeSchema], default: [] },
  checkedInAt: { type: Date, default: null },
  calledAt: { type: Date, default: null },
  consultationStartedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  cancelledAt: { type: Date, default: null },
  cancelReason: { type: String, default: null, maxlength: 300 },
  notes: { type: String, trim: true, maxlength: 500 },
  rescheduledFrom: { type: Schema.Types.ObjectId, ref: "Appointment", default: null },
  rescheduledTo: { type: Schema.Types.ObjectId, ref: "Appointment", default: null },
  chatSessionId: { type: String, default: null },
  confirmedByPatient: { type: Boolean, default: false },
  confirmedAt: { type: Date, default: null },
  lastReminderSentAt: { type: Date, default: null },
  doctorAbsent: { type: Boolean, default: false },
  doctorAbsentNotifiedAt: { type: Date, default: null },
});

// ---- Double booking is impossible at the DATABASE level ----
// 1. One active appointment per doctor + date + time.
AppointmentSchema.index(
  { doctor: 1, date: 1, slotTime: 1 },
  { unique: true, partialFilterExpression: { holdsSlot: true }, name: "uniq_active_slot" },
);
// 2. One active appointment per patient per doctor per day.
AppointmentSchema.index(
  { patient: 1, doctor: 1, date: 1 },
  { unique: true, partialFilterExpression: { holdsSlot: true }, name: "uniq_active_patient_doctor_day" },
);

// Lists and queues: "today's appointments", "this doctor's queue", "this patient's history"
AppointmentSchema.index({ date: 1, doctor: 1, status: 1 });
AppointmentSchema.index({ date: 1, status: 1 });
AppointmentSchema.index({ patient: 1, date: -1 });
// Management analytics: bookings by channel, and booking lead time
AppointmentSchema.index({ source: 1, date: 1 });
AppointmentSchema.index({ createdAt: 1, status: 1 });

AppointmentSchema.plugin(basePlugin);

export const AppointmentModel =
  mongoose.models.Appointment ||
  mongoose.model<IAppointment, mongoose.Model<IAppointment, object, IBaseMethods>>("Appointment", AppointmentSchema);
