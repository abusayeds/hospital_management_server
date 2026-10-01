import { NextFunction, Request, Response } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { env } from "../config/env";
import { TErrorResponse } from "../interface/error";
import { recordAudit } from "../modules/audit/audit.service";
import { ACCESS_COOKIE, hashToken, REFRESH_COOKIE, verifyAccessToken } from "../modules/auth/tokens";
import { blockedUntil, countRequest, isExemptIp } from "../modules/security/security.service";
import AppError from "../errors/AppError";

const tooManyRequests = (message: string): TErrorResponse => ({ error: { code: "RATE_LIMITED", message } });
const FIFTEEN_MIN = 15 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const ipKey = (req: Request) => ipKeyGenerator(req.ip ?? "unknown");

/** The signed-in user id from the access cookie (signature checked; no database call) */
const userIdOf = (req: Request): string | null => {
  const token = req.cookies?.[ACCESS_COOKIE];
  if (!token) return null;
  try {
    return verifyAccessToken(token).sub;
  } catch {
    return null;
  }
};

// Applied to every /api route: slows down scraping and brute force.
export const generalLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: () => env.RATE_LIMIT_MAX, // read per request: tests and hot config can change it
  standardHeaders: "draft-7",
  legacyHeaders: false,
  // Health checks, and Meta's signed webhook calls (many patients share Meta's few IP addresses)
  skip: (req) => req.originalUrl.startsWith("/api/v1/health") || req.originalUrl.startsWith("/api/v1/webhooks/"),
  message: tooManyRequests("Too many requests. Please slow down and try again shortly."),
});

// Login is the brute-force target. Keyed by IP + email so one hospital network (many staff behind
// one public IP) is not locked out by a single person's typos; per-account lockout handles slow guessing
// and the IP auto-block (security.service) handles one IP spraying many emails.
export const loginLimiter = rateLimit({
  windowMs: FIFTEEN_MIN,
  limit: () => env.AUTH_RATE_LIMIT_MAX, // read per request: tests and hot config can change it
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) =>
    `${ipKey(req)}|${String(req.body?.email ?? "")
      .trim()
      .toLowerCase()
      .slice(0, 254)}`,
  handler: (req, res, _next, options) => {
    void recordAudit({ req, action: "LOGIN_FAILED", entityType: "Auth", meta: { reason: "rate_limited" } });
    res.status(options.statusCode).json(tooManyRequests("Too many sign-in attempts. Please wait 15 minutes."));
  },
});

// Refresh: per session (refresh cookie), falling back to the IP when there is no cookie
export const refreshLimiter = rateLimit({
  windowMs: FIFTEEN_MIN,
  limit: () => env.REFRESH_RATE_LIMIT_MAX, // read per request: tests and hot config can change it
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => {
    const cookie = req.cookies?.[REFRESH_COOKIE];
    return cookie ? `rt:${hashToken(cookie)}` : `ip:${ipKey(req)}`;
  },
  message: tooManyRequests("Too many requests. Please wait a moment."),
});

// Change password: per signed-in user
export const changePasswordLimiter = rateLimit({
  windowMs: FIFTEEN_MIN,
  limit: () => env.CHANGE_PASSWORD_RATE_LIMIT_MAX, // read per request: tests and hot config can change it
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => (userIdOf(req) ? `u:${userIdOf(req)}` : `ip:${ipKey(req)}`),
  message: tooManyRequests("Too many password change attempts. Please wait 15 minutes."),
});

const isWrite = (req: Request) => !["GET", "HEAD", "OPTIONS"].includes(req.method);

// Per signed-in user per hour — a stolen session cannot be used to mass-edit or bulk-download.
// Writes and reads are counted separately (dashboards poll, so reads get a higher budget).
export const userWriteLimiter = rateLimit({
  windowMs: HOUR,
  limit: () => env.USER_WRITE_LIMIT_PER_HOUR, // read per request: tests and hot config can change it
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: (req) => !isWrite(req) || !userIdOf(req) || req.originalUrl.startsWith("/api/v1/auth/"),
  keyGenerator: (req) => `uw:${userIdOf(req)}`,
  message: tooManyRequests("Too many changes in the last hour from this account. Please wait a little."),
});
export const userReadLimiter = rateLimit({
  windowMs: HOUR,
  limit: () => env.USER_READ_LIMIT_PER_HOUR, // read per request: tests and hot config can change it
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: (req) => isWrite(req) || !userIdOf(req),
  keyGenerator: (req) => `ur:${userIdOf(req)}`,
  message: tooManyRequests("Too many requests in the last hour from this account. Please wait a little."),
});

// Public assistant chat costs money per message, so it gets a tighter per-IP budget.
export const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: tooManyRequests("Too many messages. Please wait a minute."),
});

/**
 * IP guard (before everything else on /api): refuses blocked IPs, and counts requests for the
 * circuit breaker (IP_BLOCK_THRESHOLD_PER_HOUR → blocked for IP_BLOCK_MINUTES, admins alerted).
 */
export const ipGuard = (req: Request, res: Response, next: NextFunction) => {
  const ip = req.ip ?? "";
  if (isExemptIp(ip) || req.originalUrl.startsWith("/api/v1/health") || req.originalUrl.startsWith("/api/v1/webhooks/"))
    return next();
  const until = blockedUntil(ip);
  const flooded = countRequest(ip);
  if (until || flooded) {
    const seconds = until ? Math.ceil((until.getTime() - Date.now()) / 1000) : env.IP_BLOCK_MINUTES * 60;
    res.setHeader("Retry-After", String(seconds));
    return next(
      new AppError(
        429,
        "This network has been temporarily blocked after unusual activity. Please try again later.",
        "RATE_LIMITED",
      ),
    );
  }
  next();
};
