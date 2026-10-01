import mongoose, { Schema } from "mongoose";
import { IBaseFields, basePlugin } from "../../../models/plugins/basePlugin";
import { TIME_PATTERN } from "../../../utils/date";

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
  // Four-eyes rule: lab results must be verified by a different person than the one who entered them
  labFourEyes: boolean;
  // Patient assistant (Phase 5)
  assistantDailyAiBudget: number; // max AI calls per day for the assistant (cost guard)
  assistantEmergencyKeywords: string[]; // extra emergency words/phrases, added to the built-in list
  assistantTakeoverReminderMinutes: number; // remind staff when a taken-over chat waits this long
  // Automation (Phase 6)
  automationPaused: boolean; // global kill switch: planners and the dispatcher do nothing
  quietHoursStart: string; // HH:mm Asia/Dhaka — no non-urgent patient messages from here …
  quietHoursEnd: string; // … until here (the window may cross midnight)
  messageNumerals: "bn" | "en"; // digits in Bangla messages: ১২৩ or 123
  automationDailyBudget: number; // max automated patient messages per day, all rules together
  perPhoneDailyCap: number; // max non-essential automated messages per phone per day
  dedupeWindowMinutes: number; // identical text to the same phone inside this window is suppressed
  simulateWhatsApp: boolean; // dry-run: messages go to the simulator, never to Meta
  simulateSms: boolean; // dry-run for the SMS fallback
  smsFallbackEnabled: boolean; // try SMS when WhatsApp cannot deliver
  failureAlertThreshold: number; // alert admins when this many sends fail within an hour
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
  labFourEyes: { type: Boolean, default: true },
  assistantDailyAiBudget: { type: Number, default: 3000, min: 0, max: 1_000_000 },
  assistantEmergencyKeywords: { type: [String], default: [] },
  assistantTakeoverReminderMinutes: { type: Number, default: 5, min: 1, max: 120 },
  automationPaused: { type: Boolean, default: false },
  quietHoursStart: { type: String, default: "21:00", match: TIME_PATTERN },
  quietHoursEnd: { type: String, default: "09:00", match: TIME_PATTERN },
  messageNumerals: { type: String, enum: ["bn", "en"], default: "bn" },
  automationDailyBudget: { type: Number, default: 500, min: 0, max: 100_000 },
  perPhoneDailyCap: { type: Number, default: 3, min: 1, max: 20 },
  dedupeWindowMinutes: { type: Number, default: 30, min: 0, max: 24 * 60 },
  simulateWhatsApp: { type: Boolean, default: true },
  simulateSms: { type: Boolean, default: true },
  smsFallbackEnabled: { type: Boolean, default: true },
  failureAlertThreshold: { type: Number, default: 5, min: 1, max: 1000 },
});
HospitalSettingsSchema.plugin(basePlugin);

export const HospitalSettingsModel =
  mongoose.models.HospitalSettings || mongoose.model<IHospitalSettings>("HospitalSettings", HospitalSettingsSchema);
