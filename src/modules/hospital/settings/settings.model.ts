import mongoose, { Schema } from "mongoose";
import { IBaseFields, basePlugin } from "../../../models/plugins/basePlugin";

// Exactly one document (key "default"). Secrets never live here — they stay in .env.
export interface IHospitalSettings extends IBaseFields {
  key: "default";
  name: string;
  nameBn: string;
  address: string;
  addressBn?: string;
  phones: string[];
  emergencyPhone: string;
  email?: string;
  openingHours: string; // e.g. "Saturday–Thursday, 9:00 AM – 9:00 PM"
  openingHoursBn?: string;
  logoUrl?: string;
  bookingWindowDays: number; // how far ahead patients may book
  cancellationCutoffMinutes: number; // no cancelling this close to the appointment
  defaultSlotMinutes: number; // pre-filled in the schedule editor
  displayNotice?: string; // scrolling line at the bottom of the waiting-room TV
}

const HospitalSettingsSchema = new Schema<IHospitalSettings>({
  key: { type: String, default: "default", unique: true, immutable: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  nameBn: { type: String, required: true, trim: true, maxlength: 120 },
  address: { type: String, required: true, trim: true, maxlength: 300 },
  addressBn: { type: String, trim: true, maxlength: 300 },
  phones: { type: [String], default: [] },
  emergencyPhone: { type: String, required: true, trim: true },
  email: { type: String, trim: true, lowercase: true },
  openingHours: { type: String, required: true, trim: true },
  openingHoursBn: { type: String, trim: true },
  logoUrl: { type: String, trim: true },
  bookingWindowDays: { type: Number, default: 14, min: 1, max: 90 },
  cancellationCutoffMinutes: { type: Number, default: 60, min: 0, max: 24 * 60 },
  defaultSlotMinutes: { type: Number, default: 10, min: 5, max: 120 },
  displayNotice: { type: String, trim: true, maxlength: 300 },
});
HospitalSettingsSchema.plugin(basePlugin);

export const HospitalSettingsModel =
  mongoose.models.HospitalSettings || mongoose.model<IHospitalSettings>("HospitalSettings", HospitalSettingsSchema);
