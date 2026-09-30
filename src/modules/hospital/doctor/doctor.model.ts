import mongoose, { HydratedDocument, Schema, Types } from "mongoose";
import { basePlugin, IBaseFields, IBaseMethods } from "../../../models/plugins/basePlugin";
import { DATE_PATTERN, TIME_PATTERN } from "../../../utils/date";
import type { Leave, ScheduleSession } from "../scheduling/slotEngine";

export interface IDoctor extends IBaseFields {
  name: string;
  nameBn?: string;
  title: string; // "Dr.", "Prof. Dr.", "Assoc. Prof. Dr."
  degrees?: string;
  specialization?: string;
  department: Types.ObjectId;
  // Money in poisha (see utils/money.ts)
  consultationFee: number;
  followUpFee: number; // charged when the patient returns within followUpValidDays
  followUpValidDays: number;
  maxPatientsPerSession: number; // default for new sessions in the editor
  averageMinutesPerPatient: number; // used for "estimated waiting time"
  roomNo?: string;
  photoUrl?: string;
  bio?: string;
  languages: string[];
  isActive: boolean;
  // The doctor's login account (Phase 2 User with role "doctor"). One-to-one: unique index below.
  user?: Types.ObjectId | null;
  sessions: ScheduleSession[]; // weekly schedule; several sessions per day allowed (morning/evening)
  leaves: Leave[];
}

export type DoctorDocument = HydratedDocument<IDoctor, IBaseMethods>;

const SessionSchema = new Schema<ScheduleSession>(
  {
    dayOfWeek: { type: Number, min: 0, max: 6, required: true },
    startTime: { type: String, match: TIME_PATTERN, required: true },
    endTime: { type: String, match: TIME_PATTERN, required: true },
    slotMinutes: { type: Number, min: 5, max: 120, required: true },
    maxPatients: { type: Number, min: 1, max: 200, required: true },
  },
  { _id: false },
);

const LeaveSchema = new Schema<Leave>(
  {
    from: { type: String, match: DATE_PATTERN, required: true },
    to: { type: String, match: DATE_PATTERN, required: true },
    reason: { type: String, trim: true, maxlength: 120 },
  },
  { _id: false },
);

const DoctorSchema = new Schema<IDoctor>({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  nameBn: { type: String, trim: true, maxlength: 100 },
  title: { type: String, default: "Dr.", trim: true, maxlength: 30 },
  degrees: { type: String, trim: true, maxlength: 200 },
  specialization: { type: String, trim: true, maxlength: 120 },
  department: { type: Schema.Types.ObjectId, ref: "Department", required: true, index: true },
  consultationFee: { type: Number, required: true, min: 0 },
  followUpFee: { type: Number, required: true, min: 0 },
  followUpValidDays: { type: Number, default: 30, min: 0, max: 365 },
  maxPatientsPerSession: { type: Number, default: 30, min: 1, max: 200 },
  averageMinutesPerPatient: { type: Number, default: 10, min: 1, max: 120 },
  roomNo: { type: String, trim: true, maxlength: 20 },
  photoUrl: { type: String, trim: true },
  bio: { type: String, trim: true, maxlength: 1000 },
  languages: { type: [String], default: ["Bangla", "English"] },
  isActive: { type: Boolean, default: true, index: true },
  user: { type: Schema.Types.ObjectId, ref: "User", default: null },
  sessions: { type: [SessionSchema], default: [] },
  leaves: { type: [LeaveSchema], default: [] },
});

// One login account ↔ at most one doctor profile (null = not linked, allowed many times)
DoctorSchema.index({ user: 1 }, { unique: true, partialFilterExpression: { user: { $type: "objectId" } } });
// "Which doctors sit on a Tuesday?" (availableOn filter, booking pickers)
DoctorSchema.index({ "sessions.dayOfWeek": 1, isActive: 1 });
DoctorSchema.index({ name: 1 });

DoctorSchema.plugin(basePlugin);

export const DoctorModel =
  mongoose.models.Doctor ||
  mongoose.model<IDoctor, mongoose.Model<IDoctor, object, IBaseMethods>>("Doctor", DoctorSchema);
