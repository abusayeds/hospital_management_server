import mongoose, { HydratedDocument, Schema, Types } from "mongoose";

/**
 * AUTOMATION JOB — one planned send. Planners and event consumers CREATE jobs; only the dispatcher
 * sends them. The unique (ruleKey, dedupeKey) index makes planning idempotent: running a planner twice,
 * or receiving the same event twice, can never create a second job.
 *
 *   scheduled ──due──▶ ready ──lease──▶ sending ──▶ sent | failed
 *       │                 │                └──(quiet hours / limits)──▶ scheduled again (deferred)
 *       └──────────────┴──▶ cancelled (precondition failed, opt-out, rule off) | superseded (rescheduled)
 * "draft" jobs come from the Preview tool and are never dispatched.
 */

export const JOB_STATUSES = [
  "draft",
  "scheduled",
  "ready",
  "sending",
  "sent",
  "failed",
  "cancelled",
  "superseded",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const OPEN_JOB_STATUSES: JobStatus[] = ["scheduled", "ready"];

export const SCOPE_TYPES = [
  "appointment",
  "visit",
  "lab_order",
  "conversation",
  "patient",
  "doctor",
  "system",
] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

/** Why a job was sent, deferred, skipped or cancelled — shown in the admin UI and used in tests */
export const DECISION_REASONS = [
  "sent",
  "optOut",
  "quietHours",
  "rateLimit",
  "budgetExceeded",
  "preconditionFailed",
  "duplicateSuppressed",
  "ruleDisabled",
  "noRecipient",
  "superseded",
  "manual",
  "sendFailed",
] as const;
export type DecisionReason = (typeof DECISION_REASONS)[number];

export type SendAttempt = { at: Date; channel: string; result: "sent" | "failed"; error?: string | null };
export type Decision = {
  at: Date;
  action: "sent" | "deferred" | "skipped" | "cancelled" | "failed" | "retried";
  reason: DecisionReason;
  detail?: string;
};

export interface IAutomationJob {
  ruleKey: string;
  dedupeKey: string; // e.g. "apt:<id>:T-24h", "fup:<visitId>:D-3", "lab:<id>:ready"
  scopeType: ScopeType;
  scopeId: string;
  patient?: Types.ObjectId | null;
  scheduledFor: Date;
  originalScheduledFor: Date; // before any deferral
  status: JobStatus;
  urgent: boolean; // may override quiet hours if the rule allows it
  data: Record<string, unknown>; // rule-specific ids (never names or clinical text)
  lease?: { workerId: string; until: Date } | null;
  sendAttempts: SendAttempt[];
  decisions: Decision[];
  deferCount: number;
  cancelReason?: string | null;
  supersededBy?: Types.ObjectId | null;
  outboxMessage?: Types.ObjectId | null;
  lastError?: string | null;
  sentAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export type AutomationJobDocument = HydratedDocument<IAutomationJob>;

const JobSchema = new Schema<IAutomationJob>(
  {
    ruleKey: { type: String, required: true },
    dedupeKey: { type: String, required: true, maxlength: 200 },
    scopeType: { type: String, enum: SCOPE_TYPES, required: true },
    scopeId: { type: String, required: true },
    patient: { type: Schema.Types.ObjectId, ref: "Patient", default: null },
    scheduledFor: { type: Date, required: true },
    originalScheduledFor: { type: Date, required: true },
    status: { type: String, enum: JOB_STATUSES, default: "scheduled" },
    urgent: { type: Boolean, default: false },
    data: { type: Schema.Types.Mixed, default: {} },
    lease: {
      type: new Schema({ workerId: String, until: Date }, { _id: false }),
      default: null,
    },
    sendAttempts: {
      type: [
        new Schema<SendAttempt>(
          { at: Date, channel: String, result: String, error: { type: String, default: null } },
          { _id: false },
        ),
      ],
      default: [],
    },
    decisions: {
      type: [
        new Schema<Decision>(
          { at: Date, action: String, reason: { type: String, enum: DECISION_REASONS }, detail: String },
          { _id: false },
        ),
      ],
      default: [],
    },
    deferCount: { type: Number, default: 0 },
    cancelReason: { type: String, default: null, maxlength: 300 },
    supersededBy: { type: Schema.Types.ObjectId, ref: "AutomationJob", default: null },
    outboxMessage: { type: Schema.Types.ObjectId, ref: "OutboxMessage", default: null },
    lastError: { type: String, default: null, maxlength: 500 },
    sentAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Idempotency: one job per rule + dedupe key, ever
JobSchema.index({ ruleKey: 1, dedupeKey: 1 }, { unique: true });
// Dispatcher: due jobs; queue page: next hour
JobSchema.index({ status: 1, scheduledFor: 1 });
// "cancel every open job for this appointment"
JobSchema.index({ scopeType: 1, scopeId: 1, status: 1 });
JobSchema.index({ patient: 1, createdAt: -1 });

export const AutomationJobModel =
  mongoose.models.AutomationJob || mongoose.model<IAutomationJob>("AutomationJob", JobSchema);
