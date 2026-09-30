import { buildPagination } from "../../interface/global.interface";
import { addDays, startOfDhakaDay, todayInDhaka } from "../../utils/date";
import { AuditAction, AuditLogModel } from "./auditLog.model";

// Read side of the audit log (the write side is audit.service.ts)

type Filters = {
  actor?: string;
  action?: AuditAction[];
  entityType?: string;
  entityId?: string;
  from?: string; // YYYY-MM-DD, Dhaka time
  to?: string;
  page: number;
  limit: number;
};

export const listAuditLogs = async (f: Filters) => {
  const filter: Record<string, unknown> = {};
  if (f.actor) filter.actor = f.actor;
  if (f.action?.length) filter.action = { $in: f.action };
  if (f.entityType) filter.entityType = f.entityType;
  if (f.entityId) filter.entityId = f.entityId;
  if (f.from || f.to) {
    filter.createdAt = {
      ...(f.from && { $gte: startOfDhakaDay(f.from) }),
      ...(f.to && { $lt: startOfDhakaDay(addDays(f.to, 1)) }), // inclusive end day
    };
  }

  const [items, total] = await Promise.all([
    AuditLogModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((f.page - 1) * f.limit)
      .limit(f.limit)
      .populate("actor", "name email role")
      .lean(),
    AuditLogModel.countDocuments(filter),
  ]);
  return {
    items: items.map(({ _id, ...rest }) => ({ id: String(_id), ...rest })),
    pagination: buildPagination(f.page, f.limit, total),
  };
};

// Today's security numbers for the admin dashboard
export const getSecurityStats = async () => {
  const since = startOfDhakaDay(todayInDhaka());
  const count = (actions: AuditAction[]) =>
    AuditLogModel.countDocuments({ action: { $in: actions }, createdAt: { $gte: since } });
  const [failedLogins, lockouts, permissionDenied, logins] = await Promise.all([
    count(["LOGIN_FAILED"]),
    count(["ACCOUNT_LOCKED"]),
    count(["PERMISSION_DENIED"]),
    count(["LOGIN"]),
  ]);
  return {
    failedLoginsToday: failedLogins,
    lockoutsToday: lockouts,
    permissionDeniedToday: permissionDenied,
    loginsToday: logins,
  };
};
