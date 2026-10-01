import mongoose, { Schema } from "mongoose";

/**
 * AUTOMATION RUN — one planner cycle, event reaction or dispatcher tick, with its counts.
 * The Run Log tab and the health page read these; old runs expire after 30 days.
 */
export interface IAutomationRun {
  ruleKey: string; // a rule key, or "dispatcher"
  kind: "planner" | "event" | "dispatch" | "preview";
  trigger?: string | null; // event name or "cron"
  startedAt: Date;
  finishedAt?: Date | null;
  scanned: number;
  created: number;
  cancelled: number;
  sent: number;
  deferred: number;
  skipped: number;
  failed: number;
  errors: string[];
  dryRun: boolean;
}

const RunSchema = new Schema<IAutomationRun>({
  ruleKey: { type: String, required: true },
  kind: { type: String, enum: ["planner", "event", "dispatch", "preview"], required: true },
  trigger: { type: String, default: null },
  startedAt: { type: Date, required: true },
  finishedAt: { type: Date, default: null },
  scanned: { type: Number, default: 0 },
  created: { type: Number, default: 0 },
  cancelled: { type: Number, default: 0 },
  sent: { type: Number, default: 0 },
  deferred: { type: Number, default: 0 },
  skipped: { type: Number, default: 0 },
  failed: { type: Number, default: 0 },
  errors: { type: [String], default: [] },
  dryRun: { type: Boolean, default: false },
});

RunSchema.index({ ruleKey: 1, startedAt: -1 });
RunSchema.index({ startedAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

export const AutomationRunModel =
  mongoose.models.AutomationRun || mongoose.model<IAutomationRun>("AutomationRun", RunSchema);
