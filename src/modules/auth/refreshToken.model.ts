import mongoose, { Schema, Types } from "mongoose";

/**
 * One row per issued refresh token. Only a SHA-256 hash is stored, so a
 * database leak does not leak usable tokens.
 *
 * sessionId groups the chain of tokens produced by rotation (one login = one
 * session). Rotating keeps the sessionId; the access token carries it, so
 * revoking a session also invalidates its access tokens immediately.
 */
export interface IRefreshToken {
  user: Types.ObjectId;
  sessionId: string;
  tokenHash: string;
  userAgent?: string;
  ip?: string;
  expiresAt: Date;
  revokedAt?: Date | null;
  revokedReason?: string | null;
  replacedBy?: Types.ObjectId | null;
  createdAt?: Date;
}

const RefreshTokenSchema = new Schema<IRefreshToken>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    sessionId: { type: String, required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    userAgent: { type: String, maxlength: 300 },
    ip: { type: String, maxlength: 64 },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: null },
    replacedBy: { type: Schema.Types.ObjectId, ref: "RefreshToken", default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// TTL index: MongoDB deletes each record automatically once expiresAt has passed
RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RefreshTokenModel =
  mongoose.models.RefreshToken || mongoose.model<IRefreshToken>("RefreshToken", RefreshTokenSchema);
