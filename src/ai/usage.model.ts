import mongoose, { Schema, Types } from "mongoose";

/**
 * One row per AI call: what feature, which model and prompt version, how long, how big, and
 * whether it worked. NO prompt or answer text is stored here (they may contain clinical data).
 * Used for cost tracking and to spot a failing provider.
 */
export interface IAiUsage {
  feature: string;
  provider: string;
  model: string | null;
  promptVersion: string;
  status: "ok" | "timeout" | "invalid_output" | "error";
  latencyMs: number;
  inputChars: number;
  outputChars: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  user?: Types.ObjectId | null;
  entityId?: string | null;
  error?: string | null;
  createdAt?: Date;
}

const AiUsageSchema = new Schema<IAiUsage>(
  {
    feature: { type: String, required: true, index: true },
    provider: { type: String, required: true },
    model: { type: String, default: null },
    promptVersion: { type: String, required: true },
    status: { type: String, enum: ["ok", "timeout", "invalid_output", "error"], required: true },
    latencyMs: { type: Number, required: true },
    inputChars: { type: Number, required: true },
    outputChars: { type: Number, default: 0 },
    inputTokens: { type: Number, default: null },
    outputTokens: { type: Number, default: null },
    user: { type: Schema.Types.ObjectId, ref: "User", default: null },
    entityId: { type: String, default: null },
    error: { type: String, default: null, maxlength: 300 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
AiUsageSchema.index({ createdAt: -1 });

export const AiUsageModel = mongoose.models.AiUsage || mongoose.model<IAiUsage>("AiUsage", AiUsageSchema);
