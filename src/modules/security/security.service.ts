/* eslint-disable @typescript-eslint/no-explicit-any */
import { Request } from "express";
import { env } from "../../config/env";
import { logger } from "../../utils/logger";
import { AuditLogModel } from "../audit/auditLog.model";
import { recordAudit } from "../audit/audit.service";
import { sendToStaff } from "../automation/outbox/outbox.service";
import { IpBlockModel } from "./ipBlock.model";

/**
 * IP PROTECTION
 *   - circuit breaker: more than IP_BLOCK_THRESHOLD_PER_HOUR requests from one IP in an hour → blocked
 *   - failed sign-ins: FAILED_LOGIN_BLOCK_THRESHOLD failures from one IP in an hour → blocked + admin alert
 * Counters live in memory (fast; per process). Blocks are stored in MongoDB so every process and a
 * restart see them, and admins can lift them on the Security page. Loopback and IP_ALLOWLIST are exempt.
 */

const HOUR = 60 * 60 * 1000;
type Counter = { count: number; windowStart: number };
const requestCounts = new Map<string, Counter>();
const failedLogins = new Map<string, Counter>();
let blocked = new Map<string, Date>();
let lastSync = 0;
let syncing: Promise<void> | null = null;

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
export const isExemptIp = (ip?: string | null) => !ip || LOOPBACK.has(ip) || env.IP_ALLOWLIST.includes(ip);

const bump = (map: Map<string, Counter>, ip: string, now = Date.now()) => {
  let c = map.get(ip);
  if (!c || now - c.windowStart >= HOUR) {
    c = { count: 0, windowStart: now };
    map.set(ip, c);
  }
  c.count += 1;
  return c.count;
};

// Forget finished windows so memory stays small
setInterval(
  () => {
    const now = Date.now();
    for (const map of [requestCounts, failedLogins])
      for (const [ip, c] of map) if (now - c.windowStart >= HOUR) map.delete(ip);
  },
  10 * 60 * 1000,
).unref();

/** Reload active blocks from the database (other processes may have added or lifted some) */
export const syncBlocks = (): Promise<void> => {
  syncing ??= IpBlockModel.find({ until: { $gt: new Date() } })
    .select("ip until")
    .lean()
    .then((docs) => {
      blocked = new Map(docs.map((d) => [d.ip, d.until]));
      lastSync = Date.now();
    })
    .catch((err) => logger.error({ err }, "Could not load IP blocks"))
    .finally(() => {
      syncing = null;
    });
  return syncing;
};

export const blockedUntil = (ip: string): Date | null => {
  if (Date.now() - lastSync > 30_000) void syncBlocks();
  const until = blocked.get(ip);
  return until && until.getTime() > Date.now() ? until : null;
};

export const blockIp = async (ip: string, reason: "request_flood" | "failed_logins", hits: number) => {
  const until = new Date(Date.now() + env.IP_BLOCK_MINUTES * 60_000);
  blocked.set(ip, until);
  logger.warn({ ip, reason, hits }, "IP blocked");
  try {
    await IpBlockModel.updateOne(
      { ip },
      {
        $set: { reason, hits, blockedAt: new Date(), until, liftedBy: null, liftedAt: null },
        $inc: { timesBlocked: 1 },
      },
      { upsert: true },
    );
    await recordAudit({
      actor: null,
      action: "IP_BLOCKED",
      entityType: "IpAddress",
      entityId: ip,
      meta: { reason, hits, until },
    });
    const why = reason === "failed_logins" ? `${hits} failed sign-ins in an hour` : `${hits} requests in an hour`;
    await sendToStaff({
      permission: "settings:manage",
      source: "system",
      loud: reason === "failed_logins",
      text: `🔒 IP ${ip} blocked for ${env.IP_BLOCK_MINUTES} min (${why}). Admin → Security to review or lift the block.`,
      related: { type: "system", id: `ip:${ip}` },
    });
  } catch (err) {
    logger.error({ err, ip }, "Could not store an IP block");
  }
};

/** Count one API request; true when this IP must be refused */
export const countRequest = (ip: string): boolean => {
  if (isExemptIp(ip)) return false;
  const n = bump(requestCounts, ip);
  if (n === env.IP_BLOCK_THRESHOLD_PER_HOUR + 1) void blockIp(ip, "request_flood", n);
  return n > env.IP_BLOCK_THRESHOLD_PER_HOUR;
};

/** Called by the sign-in code on every failure */
export const noteFailedLogin = (ip?: string | null) => {
  if (!ip || isExemptIp(ip)) return;
  const n = bump(failedLogins, ip);
  if (n === env.FAILED_LOGIN_BLOCK_THRESHOLD) void blockIp(ip, "failed_logins", n);
};

export const unblockIp = async (req: Request, ip: string) => {
  const res = await IpBlockModel.findOneAndUpdate(
    { ip, until: { $gt: new Date() } },
    { $set: { until: new Date(), liftedBy: req.user?.id ?? null, liftedAt: new Date() } },
    { new: true },
  ).lean();
  blocked.delete(ip);
  requestCounts.delete(ip);
  failedLogins.delete(ip);
  await recordAudit({
    req,
    action: "UPDATE",
    entityType: "IpAddress",
    entityId: ip,
    meta: { event: "unblock", wasBlocked: Boolean(res) },
  });
  return { ip, lifted: Boolean(res) };
};

/** Test helper: forget all counters and blocks held in memory */
export const resetIpProtection = () => {
  requestCounts.clear();
  failedLogins.clear();
  blocked.clear();
  lastSync = Date.now();
};

// ------------------------------------------------------------------ Security page

const dhakaHour = (d: Date) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  })
    .format(d)
    .replace(" ", "T")
    .slice(0, 13) + ":00";

export const securityOverview = async () => {
  const now = new Date();
  const since24h = new Date(now.getTime() - 24 * HOUR);
  const [failedByHour, topIps, counts, blocks, permissionChanges] = await Promise.all([
    AuditLogModel.aggregate([
      { $match: { action: "LOGIN_FAILED", createdAt: { $gte: since24h } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%dT%H:00", date: "$createdAt", timezone: "Asia/Dhaka" } },
          n: { $sum: 1 },
        },
      },
    ]),
    AuditLogModel.aggregate([
      { $match: { action: "LOGIN_FAILED", createdAt: { $gte: since24h }, ip: { $ne: null } } },
      { $group: { _id: "$ip", count: { $sum: 1 }, last: { $max: "$createdAt" } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]),
    AuditLogModel.aggregate([
      {
        $match: {
          createdAt: { $gte: since24h },
          action: {
            $in: [
              "LOGIN",
              "LOGIN_FAILED",
              "ACCOUNT_LOCKED",
              "PERMISSION_DENIED",
              "TOKEN_REUSE_DETECTED",
              "IP_BLOCKED",
              "EXPORT",
            ],
          },
        },
      },
      { $group: { _id: "$action", n: { $sum: 1 } } },
    ]),
    IpBlockModel.find({
      $or: [{ until: { $gt: now } }, { blockedAt: { $gte: new Date(now.getTime() - 7 * 24 * HOUR) } }],
    })
      .sort({ blockedAt: -1 })
      .limit(50)
      .lean(),
    AuditLogModel.find({ action: { $in: ["ROLE_CHANGE", "ACTIVATE", "DEACTIVATE", "PASSWORD_RESET"] } })
      .sort({ createdAt: -1 })
      .limit(20)
      .select("action actorLabel actorRole entityType entityId meta createdAt")
      .lean(),
  ]);

  // 24 hourly buckets ending now, zero-filled
  const hours = Array.from({ length: 24 }, (_, i) => {
    const hour = dhakaHour(new Date(now.getTime() - (23 - i) * HOUR));
    return { hour, failed: failedByHour.find((r: any) => r._id === hour)?.n ?? 0 };
  });
  const count = (a: string) => counts.find((c: any) => c._id === a)?.n ?? 0;

  return {
    last24h: {
      logins: count("LOGIN"),
      failedLogins: count("LOGIN_FAILED"),
      lockedAccounts: count("ACCOUNT_LOCKED"),
      permissionDenied: count("PERMISSION_DENIED"),
      tokenReuse: count("TOKEN_REUSE_DETECTED"),
      ipBlocks: count("IP_BLOCKED"),
      exports: count("EXPORT"),
    },
    failedLoginsByHour: hours,
    topFailingIps: topIps.map((r: any) => ({
      ip: r._id,
      count: r.count,
      last: r.last,
      blocked: Boolean(blockedUntil(r._id)),
    })),
    blocks: blocks.map((b) => ({
      ip: b.ip,
      reason: b.reason,
      hits: b.hits,
      blockedAt: b.blockedAt,
      until: b.until,
      active: b.until.getTime() > now.getTime(),
      timesBlocked: b.timesBlocked,
      liftedAt: b.liftedAt,
    })),
    permissionChanges: permissionChanges.map((p: any) => ({
      action: p.action,
      actor: p.actorLabel ?? "system",
      actorRole: p.actorRole,
      entityType: p.entityType,
      entityId: p.entityId,
      meta: p.meta ?? null,
      at: p.createdAt,
    })),
    limits: {
      loginPer15Min: env.AUTH_RATE_LIMIT_MAX,
      refreshPer15Min: env.REFRESH_RATE_LIMIT_MAX,
      changePasswordPer15Min: env.CHANGE_PASSWORD_RATE_LIMIT_MAX,
      userWritesPerHour: env.USER_WRITE_LIMIT_PER_HOUR,
      userReadsPerHour: env.USER_READ_LIMIT_PER_HOUR,
      chatPerHour: env.CHAT_HOURLY_LIMIT,
      ipRequestsPerHour: env.IP_BLOCK_THRESHOLD_PER_HOUR,
      failedLoginsPerHour: env.FAILED_LOGIN_BLOCK_THRESHOLD,
      blockMinutes: env.IP_BLOCK_MINUTES,
    },
  };
};
