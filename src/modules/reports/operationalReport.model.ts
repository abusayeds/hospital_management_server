import mongoose, { Document, Model, Schema, Types } from "mongoose";
import { basePlugin } from "../../models/plugins/basePlugin";

/**
 * One end-of-day operations report per Dhaka date.
 * `stats` holds the aggregated numbers the report was written from (counts and money only — no patient data),
 * so the page can show the exact inputs next to the AI text. `source` says whether the AI wrote it or the
 * rule-based fallback did (AI not configured, timed out, or its text failed the safety check).
 */
export interface IOperationalReport {
  date: string; // YYYY-MM-DD (Dhaka)
  source: "ai" | "fallback";
  narrative: string; // Bangla
  highlights: string[];
  bullets: string[]; // plain KPI lines, always present (also the fallback body)
  stats: Record<string, unknown>;
  model: string | null;
  promptVersion: string | null;
  fallbackReason: string | null;
  generatedAt: Date;
  generatedBy: Types.ObjectId | null; // null = the automation rule
  deliveredAt: Date | null;
  deliveryCount: number;
}
export type OperationalReportDocument = Document & IOperationalReport;

const OperationalReportSchema = new Schema<IOperationalReport>(
  {
    date: { type: String, required: true, unique: true },
    source: { type: String, enum: ["ai", "fallback"], required: true },
    narrative: { type: String, required: true, maxlength: 4000 },
    highlights: { type: [String], default: [] },
    bullets: { type: [String], default: [] },
    stats: { type: Schema.Types.Mixed, default: {} },
    model: { type: String, default: null },
    promptVersion: { type: String, default: null },
    fallbackReason: { type: String, default: null },
    generatedAt: { type: Date, required: true },
    generatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    deliveredAt: { type: Date, default: null },
    deliveryCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);
OperationalReportSchema.plugin(basePlugin);

export const OperationalReportModel: Model<IOperationalReport> =
  mongoose.models.OperationalReport || mongoose.model<IOperationalReport>("OperationalReport", OperationalReportSchema);
