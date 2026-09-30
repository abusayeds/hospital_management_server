import { NextFunction, Request, Response } from "express";
import { env } from "../config/env";
import AppError from "../errors/AppError";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence for cookie-based auth (layer 3 of 3 — see PHASE_LOG):
 *  1. cookies are sameSite=lax → browsers don't attach them to cross-site POSTs
 *  2. CORS allows only CLIENT_URL, and the API only accepts JSON bodies
 *  3. this check: a state-changing request that carries an Origin/Referer from
 *     any other site is rejected, even if an old browser ignored sameSite.
 * Requests without Origin (curl, server-to-server, tests) carry no browser
 * cookies automatically, so they are not a CSRF risk and are allowed.
 */
export const verifyOrigin = (req: Request, _res: Response, next: NextFunction) => {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.get("origin") ?? originOf(req.get("referer"));
  if (origin && !env.CLIENT_URL.includes(origin)) {
    return next(new AppError(403, "Request blocked for security reasons.", "CSRF_REJECTED"));
  }
  next();
};

const originOf = (url?: string) => {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};
