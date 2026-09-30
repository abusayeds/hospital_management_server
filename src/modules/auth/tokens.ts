import { createHash, randomBytes, randomUUID } from "crypto";
import { CookieOptions, Response } from "express";
import jwt from "jsonwebtoken";
import { env, isProduction } from "../../config/env";
import type { Role } from "../../config/permissions";

/**
 * Cookies (all httpOnly — JavaScript in the browser can never read them):
 *  - tl_access  : JWT, 15 min, sent on every request (path "/")
 *  - tl_refresh : random opaque token, 7 days, sent ONLY to /api/v1/auth
 *  - tl_session : "1", no secret — lets the Next.js route guard know someone
 *                 is signed in so it can redirect to /login without a round trip
 * sameSite=lax + secure in production. See docs/PROJECT_CONTEXT.md (Auth design).
 */
export const ACCESS_COOKIE = "tl_access";
export const REFRESH_COOKIE = "tl_refresh";
export const SESSION_COOKIE = "tl_session";
const REFRESH_PATH = "/api/v1/auth";

const JWT_OPTIONS = { issuer: "testolife-api", audience: "testolife-app" } as const;

export type AccessTokenPayload = { sub: string; role: Role; sid: string; iat: number; exp: number };

export const accessTtlMs = () => env.ACCESS_TOKEN_TTL_MINUTES * 60 * 1000;
export const refreshTtlMs = () => env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

export const signAccessToken = (user: { id: string; role: Role }, sessionId: string): string =>
  jwt.sign({ role: user.role, sid: sessionId }, env.JWT_SECRET_KEY, {
    ...JWT_OPTIONS,
    subject: user.id,
    expiresIn: env.ACCESS_TOKEN_TTL_MINUTES * 60,
    algorithm: "HS256",
  });

// Throws JsonWebTokenError / TokenExpiredError on bad input
export const verifyAccessToken = (token: string): AccessTokenPayload =>
  jwt.verify(token, env.JWT_SECRET_KEY, { ...JWT_OPTIONS, algorithms: ["HS256"] }) as AccessTokenPayload;

// 384 bits of randomness; only its hash is stored in the database
export const generateRefreshToken = (): string => randomBytes(48).toString("base64url");
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
export const newSessionId = (): string => randomUUID();

const baseCookie = (): CookieOptions => ({ httpOnly: true, secure: isProduction, sameSite: "lax" });

export const setAuthCookies = (res: Response, accessToken: string, refreshToken: string) => {
  res.cookie(ACCESS_COOKIE, accessToken, { ...baseCookie(), path: "/", maxAge: accessTtlMs() });
  res.cookie(REFRESH_COOKIE, refreshToken, { ...baseCookie(), path: REFRESH_PATH, maxAge: refreshTtlMs() });
  res.cookie(SESSION_COOKIE, "1", { ...baseCookie(), path: "/", maxAge: refreshTtlMs() });
};

export const clearAuthCookies = (res: Response) => {
  res.clearCookie(ACCESS_COOKIE, { ...baseCookie(), path: "/" });
  res.clearCookie(REFRESH_COOKIE, { ...baseCookie(), path: REFRESH_PATH });
  res.clearCookie(SESSION_COOKIE, { ...baseCookie(), path: "/" });
};

/** Minimal Cookie-header parser (used by Socket.IO, which has no cookie-parser) */
export const readCookie = (header: string | undefined, name: string): string | undefined => {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
};
