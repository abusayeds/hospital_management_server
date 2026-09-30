import { rateLimit } from "express-rate-limit";
import { env } from "../config/env";
import { TErrorResponse } from "../interface/error";

const tooManyRequests = (message: string): TErrorResponse => ({ error: { code: "RATE_LIMITED", message } });

// Applied to every /api route: slows down scraping and brute force.
export const generalLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  // Health checks, and Meta's signed webhook calls (many patients share Meta's few IP addresses)
  skip: (req) => req.originalUrl.startsWith("/api/v1/health") || req.originalUrl.startsWith("/api/v1/webhooks/"),
  message: tooManyRequests("Too many requests. Please slow down and try again shortly."),
});

// Login is the brute-force target: far stricter than the general limiter.
// (Per-account lockout handles slow guessing; this handles fast guessing from one IP.)
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.AUTH_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: tooManyRequests("Too many sign-in attempts from this device. Please wait 15 minutes."),
});

export const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.REFRESH_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: tooManyRequests("Too many requests. Please wait a moment."),
});

// Public assistant chat costs money per message, so it gets a tighter per-IP budget.
export const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: tooManyRequests("Too many messages. Please wait a minute."),
});
