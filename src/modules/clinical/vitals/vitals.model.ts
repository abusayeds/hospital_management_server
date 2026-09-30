import mongoose, { HydratedDocument, Schema, Types } from "mongoose";
import { basePlugin, IBaseFields, IBaseMethods } from "../../../models/plugins/basePlugin";
import { DATE_PATTERN } from "../../../utils/date";

/**
 * Nurse vitals — one record per appointment (the reading taken before the consultation).
 * BMI and the flags are computed on the server with the shared clinical rules and stored,
 * so lists can show "abnormal/critical" badges without recomputing.
 */
export const FLAG_LEVELS = ["normal", "abnormal", "critical"] as const;

export interface IVitals extends IBaseFields {
  appointment: Types.ObjectId;
  patient: Types.ObjectId;
  doctor: Types.ObjectId;
  date: string; // YYYY-MM-DD (Dhaka) of the appointment
  bpSystolic?: number | null;
  bpDiastolic?: number | null;
  pulse?: number | null;
  temperatureF?: number | null;
  respiratoryRate?: number | null;
  spo2?: number | null;
  weightKg?: number | null;
  heightCm?: number | null;
  bmi?: number | null;
  bloodSugar?: { value?: number | null; type?: "fasting" | "random" | null } | null;
  notes?: string;
  flags: { key: string; level: (typeof FLAG_LEVELS)[number]; label: string; labelBn: string }[];
  flagLevel: (typeof FLAG_LEVELS)[number];
  recordedBy: Types.ObjectId;
  recordedAt: Date;
}

export type VitalsDocument = HydratedDocument<IVitals, IBaseMethods>;

const num = { type: Number, default: null };

const VitalsSchema = new Schema<IVitals>({
  appointment: { type: Schema.Types.ObjectId, ref: "Appointment", required: true, unique: true },
  patient: { type: Schema.Types.ObjectId, ref: "Patient", required: true },
  doctor: { type: Schema.Types.ObjectId, ref: "Doctor", required: true },
  date: { type: String, required: true, match: DATE_PATTERN },
  bpSystolic: num,
  bpDiastolic: num,
  pulse: num,
  temperatureF: num,
  respiratoryRate: num,
  spo2: num,
  weightKg: num,
  heightCm: num,
  bmi: num,
  bloodSugar: {
    type: new Schema(
      { value: num, type: { type: String, enum: ["fasting", "random", null], default: null } },
      { _id: false },
    ),
    default: null,
  },
  notes: { type: String, trim: true, maxlength: 500 },
  flags: {
    type: [
      new Schema(
        { key: String, level: { type: String, enum: FLAG_LEVELS }, label: String, labelBn: String },
        { _id: false },
      ),
    ],
    default: [],
  },
  flagLevel: { type: String, enum: FLAG_LEVELS, default: "normal" },
  recordedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  recordedAt: { type: Date, required: true },
});

// Patient history / trend charts, newest first
VitalsSchema.index({ patient: 1, recordedAt: -1 });
VitalsSchema.index({ date: 1, doctor: 1 });
VitalsSchema.plugin(basePlugin);

export const VitalsModel =
  mongoose.models.Vitals ||
  mongoose.model<IVitals, mongoose.Model<IVitals, object, IBaseMethods>>("Vitals", VitalsSchema);
