import mongoose, { HydratedDocument, Schema, Types } from "mongoose";
import { basePlugin, IBaseFields, IBaseMethods } from "../../models/plugins/basePlugin";

export const GENDERS = ["male", "female", "other"] as const;
export const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"] as const;
export const REGISTRATION_SOURCES = ["reception", "chatbot", "whatsapp", "phone"] as const;

/**
 * What automated messages the patient wants (Phase 6). Categories can be switched off one by one;
 * optOutAll ("STOP") silences everything except essential operational messages (emergencies, the
 * hospital cancelling their booking). Marketing is opt-IN and never sent after STOP.
 */
export type PatientPreferences = {
  reminders: boolean;
  followUps: boolean;
  labReports: boolean;
  marketing: boolean;
  language: "bn" | "en";
  optOutAll: boolean;
  optOutAt?: Date | null;
  optOutReason?: string | null;
};

export interface IPatient extends IBaseFields {
  patientCode: string; // "TL-000123" from an atomic counter
  name: string;
  nameBn?: string;
  nameKey: string; // normalised name for duplicate detection (lowercase, letters only)
  gender: (typeof GENDERS)[number];
  dateOfBirth: Date;
  dobEstimated: boolean; // true when only an age was given ("about 45")
  phone: string; // +8801XXXXXXXXX — several family members may share one number
  altPhone?: string;
  address?: { area?: string; upazila?: string; district?: string };
  bloodGroup?: (typeof BLOOD_GROUPS)[number];
  allergies: string[];
  chronicConditions: string[];
  emergencyContact?: { name?: string; phone?: string; relation?: string };
  nidEncrypted?: string | null; // AES-256-GCM, never selected by default, never returned
  nidLast4?: string | null;
  notes?: string;
  registeredBy?: Types.ObjectId | null;
  registrationSource: (typeof REGISTRATION_SOURCES)[number];
  lastVisitDate?: string | null; // YYYY-MM-DD of the last completed appointment
  preferences: PatientPreferences;
}

export type PatientDocument = HydratedDocument<IPatient, IBaseMethods>;

const PatientSchema = new Schema<IPatient>({
  patientCode: { type: String, required: true, unique: true, immutable: true },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  nameBn: { type: String, trim: true, maxlength: 100 },
  nameKey: { type: String, required: true },
  gender: { type: String, enum: GENDERS, required: true },
  dateOfBirth: { type: Date, required: true },
  dobEstimated: { type: Boolean, default: false },
  phone: { type: String, required: true, match: /^\+8801[3-9]\d{8}$/ },
  altPhone: { type: String, match: /^\+8801[3-9]\d{8}$/ },
  address: {
    area: { type: String, trim: true, maxlength: 150 },
    upazila: { type: String, trim: true, maxlength: 60 },
    district: { type: String, trim: true, maxlength: 60 },
  },
  bloodGroup: { type: String, enum: BLOOD_GROUPS },
  allergies: { type: [String], default: [] },
  chronicConditions: { type: [String], default: [] },
  emergencyContact: {
    name: { type: String, trim: true, maxlength: 100 },
    phone: { type: String, match: /^\+8801[3-9]\d{8}$/ },
    relation: { type: String, trim: true, maxlength: 40 },
  },
  nidEncrypted: { type: String, default: null, select: false },
  nidLast4: { type: String, default: null },
  notes: { type: String, trim: true, maxlength: 1000 },
  registeredBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  registrationSource: { type: String, enum: REGISTRATION_SOURCES, default: "reception" },
  lastVisitDate: { type: String, default: null },
  preferences: {
    reminders: { type: Boolean, default: true },
    followUps: { type: Boolean, default: true },
    labReports: { type: Boolean, default: true },
    marketing: { type: Boolean, default: false },
    language: { type: String, enum: ["bn", "en"], default: "bn" },
    optOutAll: { type: Boolean, default: false },
    optOutAt: { type: Date, default: null },
    optOutReason: { type: String, default: null, maxlength: 200 },
  },
});

// Reception searches by phone far more than anything else ("what's your number?")
PatientSchema.index({ phone: 1, nameKey: 1 });
PatientSchema.index({ altPhone: 1 }, { sparse: true });
// Whole-word name search in English or Bangla
PatientSchema.index({ name: "text", nameBn: "text" });
PatientSchema.index({ createdAt: -1 });

PatientSchema.plugin(basePlugin);

export const PatientModel =
  mongoose.models.Patient ||
  mongoose.model<IPatient, mongoose.Model<IPatient, object, IBaseMethods>>("Patient", PatientSchema);
