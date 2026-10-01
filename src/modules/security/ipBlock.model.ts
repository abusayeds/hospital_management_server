import mongoose, { Model, Schema, Types } from "mongoose";

/**
 * An IP address blocked by the circuit breaker (request flood) or by too many failed sign-ins.
 * Kept after the block ends (until < now) so the Security page shows recent history; admins can lift
 * a block early. Every block and unblock is also in the audit log.
 */
export interface IIpBlock {
  ip: string;
  reason: "request_flood" | "failed_logins";
  hits: number;
  blockedAt: Date;
  until: Date;
  timesBlocked: number;
  liftedBy: Types.ObjectId | null;
  liftedAt: Date | null;
}

const IpBlockSchema = new Schema<IIpBlock>(
  {
    ip: { type: String, required: true, unique: true },
    reason: { type: String, enum: ["request_flood", "failed_logins"], required: true },
    hits: { type: Number, default: 0 },
    blockedAt: { type: Date, required: true },
    until: { type: Date, required: true, index: true },
    timesBlocked: { type: Number, default: 0 },
    liftedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    liftedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const IpBlockModel: Model<IIpBlock> =
  mongoose.models.IpBlock || mongoose.model<IIpBlock>("IpBlock", IpBlockSchema);
