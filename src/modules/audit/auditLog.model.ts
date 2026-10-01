import mongoose, { Schema, Types } from "mongoose";
import { ROLES } from "../../config/permissions";

export const AUDIT_ACTIONS = [
  "LOGIN",
  "LOGIN_FAILED",
  "ACCOUNT_LOCKED",
  "LOGOUT",
  "LOGOUT_ALL",
  "TOKEN_REUSE_DETECTED",
  "CREATE",
  "UPDATE",
  "DELETE",
  "VIEW",
  "ROLE_CHANGE",
  "ACTIVATE",
  "DEACTIVATE",
  "PASSWORD_CHANGE",
  "PASSWORD_RESET",
  "PERMISSION_DENIED",
  "EXPORT",
  "IP_BLOCKED",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface IAuditLog {
  actor?: Types.ObjectId | null; // null for anonymous events (e.g. failed login for an unknown email)
  actorRole?: string | null;
  actorLabel?: string | null; // email/name at the time of the event (survives later renames)
  action: AuditAction;
  entityType: string; // "User", "Auth", "Patient", ...
  entityId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  meta?: Record<string, unknown> | null; // e.g. { permission: "user:manage", path: "/api/v1/users" }
  ip?: string | null;
  userAgent?: string | null;
  createdAt?: Date;
}

const AuditLogSchema = new Schema<IAuditLog>(
  {
    actor: { type: Schema.Types.ObjectId, ref: "User", default: null },
    actorRole: { type: String, enum: [...ROLES, null], default: null },
    actorLabel: { type: String, default: null },
    action: { type: String, enum: AUDIT_ACTIONS, required: true },
    entityType: { type: String, required: true },
    entityId: { type: String, default: null },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    meta: { type: Schema.Types.Mixed, default: null },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
  },
  // Only createdAt: an audit entry is never updated
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

// Filters used by the Audit Logs screen: by user, by entity, by action — newest first
AuditLogSchema.index({ createdAt: -1 });
AuditLogSchema.index({ actor: 1, createdAt: -1 });
AuditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
AuditLogSchema.index({ action: 1, createdAt: -1 });

// Append-only: any attempt to change or delete an entry through Mongoose fails.
// (Also: no update/delete endpoints exist. In production, the app's DB user
// should additionally lack update/delete rights on this collection.)
const blockMutation = function () {
  throw new Error("Audit logs are append-only and cannot be modified or deleted");
};
for (const op of [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "findOneAndReplace",
  "replaceOne",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
] as const) {
  AuditLogSchema.pre(op, blockMutation);
}
AuditLogSchema.pre("save", function () {
  if (!this.isNew) throw new Error("Audit logs are append-only and cannot be modified");
});

export const AuditLogModel = mongoose.models.AuditLog || mongoose.model<IAuditLog>("AuditLog", AuditLogSchema);
