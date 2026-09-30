import mongoose, { Schema, Types } from "mongoose";

/**
 * Phone verification codes for the web chat (one-time passwords).
 * Only a HASH of the code is stored; rows delete themselves 5 minutes after creation (TTL index).
 * `devCode` holds the plain code ONLY outside production, for the admin "dev OTP" view
 * (SMS delivery is not built yet).
 */
export interface IVerification {
  conversation: Types.ObjectId;
  phone: string; // +8801…
  codeHash: string;
  attempts: number;
  expiresAt: Date;
  usedAt?: Date | null;
  deliveredVia: "log" | "whatsapp";
  devCode?: string | null;
  createdAt?: Date;
}

const VerificationSchema = new Schema<IVerification>(
  {
    conversation: { type: Schema.Types.ObjectId, ref: "Conversation", required: true, index: true },
    phone: { type: String, required: true, index: true },
    codeHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    deliveredVia: { type: String, enum: ["log", "whatsapp"], default: "log" },
    devCode: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
// MongoDB removes the row when expiresAt passes
VerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const VerificationModel =
  mongoose.models.Verification || mongoose.model<IVerification>("Verification", VerificationSchema);
