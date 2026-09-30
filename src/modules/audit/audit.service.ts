import { Request } from "express";
import { Types } from "mongoose";
import type { Role } from "../../config/permissions";
import { logger } from "../../utils/logger";
import { AuditAction, AuditLogModel } from "./auditLog.model";

// Any key that looks like a secret is removed from before/after snapshots
const SECRET_KEY = /password|token|hash|secret|otp/i;

export const redact = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redact);
  if (value instanceof Date || value instanceof Types.ObjectId) return value;
  if (value && typeof value === "object") {
    const plain =
      typeof (value as { toObject?: () => unknown }).toObject === "function"
        ? (value as { toObject: () => Record<string, unknown> }).toObject()
        : (value as Record<string, unknown>);
    return Object.fromEntries(
      Object.entries(plain)
        .filter(([key]) => !SECRET_KEY.test(key) && key !== "__v")
        .map(([key, v]) => [key, redact(v)]),
    );
  }
  return value;
};

type AuditInput = {
  action: AuditAction;
  entityType: string;
  entityId?: string | Types.ObjectId | null;
  before?: unknown;
  after?: unknown;
  meta?: Record<string, unknown>;
  req?: Request; // actor, ip and user agent are taken from here when present
  actor?: { id: string; role: Role; label?: string } | null; // for events before req.user exists (login)
};

/**
 * Write one audit entry. Safe to call from anywhere: it NEVER throws, because
 * a failing audit write must not break the patient-facing action. Failures are
 * logged as errors so operations can investigate.
 */
export const recordAudit = async (input: AuditInput): Promise<void> => {
  const actor =
    input.actor ??
    (input.req?.user ? { id: input.req.user.id, role: input.req.user.role, label: input.req.user.email } : null);
  try {
    await AuditLogModel.create({
      actor: actor?.id ?? null,
      actorRole: actor?.role ?? null,
      actorLabel: actor?.label ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ? String(input.entityId) : null,
      before: input.before ? redact(input.before) : null,
      after: input.after ? redact(input.after) : null,
      meta: input.meta ? redact(input.meta) : null,
      ip: input.req?.ip ?? null,
      userAgent: input.req?.get("user-agent")?.slice(0, 300) ?? null,
    });
  } catch (err) {
    logger.error({ err, action: input.action, entityType: input.entityType }, "Failed to write audit log");
  }
};
