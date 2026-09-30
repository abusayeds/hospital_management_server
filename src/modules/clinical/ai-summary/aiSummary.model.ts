import mongoose, { Schema, Types } from "mongoose";

/**
 * The latest AI visit summary of a patient (one per patient) — a CACHE, not a medical record.
 * It is marked stale when new facts arrive (visit closed, lab report verified) and regenerated
 * on request. It is never copied into the record automatically.
 */
export interface IAiSummary {
  patient: Types.ObjectId;
  content: Record<string, unknown>;
  promptVersion: string;
  model: string;
  contextHash: string; // hash of the de-identified input: same input → no new AI call needed
  generatedAt: Date;
  generatedBy: Types.ObjectId;
  stale: boolean;
  staleReason?: string | null;
  feedback: { user: Types.ObjectId; rating: "up" | "down"; comment?: string; at: Date }[];
}

const AiSummarySchema = new Schema<IAiSummary>(
  {
    patient: { type: Schema.Types.ObjectId, ref: "Patient", required: true, unique: true },
    content: { type: Schema.Types.Mixed, required: true },
    promptVersion: { type: String, required: true },
    model: { type: String, required: true },
    contextHash: { type: String, required: true },
    generatedAt: { type: Date, required: true },
    generatedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    stale: { type: Boolean, default: false },
    staleReason: { type: String, default: null },
    feedback: {
      type: [
        new Schema(
          {
            user: { type: Schema.Types.ObjectId, ref: "User", required: true },
            rating: { type: String, enum: ["up", "down"], required: true },
            comment: { type: String, maxlength: 500 },
            at: { type: Date, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { timestamps: true },
);

export const AiSummaryModel = mongoose.models.AiSummary || mongoose.model<IAiSummary>("AiSummary", AiSummarySchema);
