import bcrypt from "bcrypt";
import { Request } from "express";
import { env } from "../../config/env";
import { permissionsForRole } from "../../config/permissions";
import AppError from "../../errors/AppError";
import { disconnectUser } from "../../sockets";
import { recordAudit } from "../audit/audit.service";
import { UserDocument, UserModel } from "../users/user.model";
import { RefreshTokenModel } from "./refreshToken.model";
import { generateRefreshToken, hashToken, newSessionId, refreshTtlMs, signAccessToken } from "./tokens";

export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;

// Same wording for "no such email" and "wrong password": never reveal which emails exist
const INVALID_CREDENTIALS = "Email or password is incorrect.";

export const hashPassword = (password: string) => bcrypt.hash(password, env.BCRYPT_ROUNDS);

// Comparing against a dummy hash when the email is unknown makes both paths take
// the same time, so response timing cannot be used to discover valid emails.
let dummyHash: string | null = null;
const getDummyHash = async () => (dummyHash ??= await bcrypt.hash("not-a-real-password-0", env.BCRYPT_ROUNDS));

const clientOf = (req: Request) => ({ ip: req.ip, userAgent: req.get("user-agent")?.slice(0, 300) });
const actorOf = (user: UserDocument) => ({ id: String(user._id), role: user.role, label: user.email });

export const toPublicUser = (user: UserDocument) => ({
  ...user.toJSON(),
  permissions: permissionsForRole(user.role),
});

/** Create a session: a refresh token row + a short-lived access token bound to it */
const issueSession = async (user: UserDocument, req: Request, sessionId = newSessionId()) => {
  const refreshToken = generateRefreshToken();
  const doc = await RefreshTokenModel.create({
    user: user._id,
    sessionId,
    tokenHash: hashToken(refreshToken),
    ...clientOf(req),
    expiresAt: new Date(Date.now() + refreshTtlMs()),
  });
  const accessToken = signAccessToken({ id: String(user._id), role: user.role }, sessionId);
  return { accessToken, refreshToken, sessionId, refreshTokenId: doc._id };
};

export const revokeAllSessions = async (userId: string, reason: string, exceptSessionId?: string) => {
  await RefreshTokenModel.updateMany(
    { user: userId, revokedAt: null, ...(exceptSessionId && { sessionId: { $ne: exceptSessionId } }) },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
  // Live screens of this user stop receiving data immediately (except when keeping the current session)
  if (!exceptSessionId) disconnectUser(userId);
};

// ---------------------------------------------------------------- login

export const login = async (email: string, password: string, req: Request) => {
  const user = (await UserModel.findOne({ email: email.toLowerCase() }).select("+passwordHash")) as UserDocument | null;

  if (!user) {
    await bcrypt.compare(password, await getDummyHash());
    await recordAudit({ req, action: "LOGIN_FAILED", entityType: "Auth", meta: { email, reason: "unknown_email" } });
    throw new AppError(401, INVALID_CREDENTIALS, "INVALID_CREDENTIALS");
  }

  const now = Date.now();
  if (user.lockUntil && user.lockUntil.getTime() > now) {
    const retryAfterSeconds = Math.ceil((user.lockUntil.getTime() - now) / 1000);
    await recordAudit({
      req,
      actor: actorOf(user),
      action: "LOGIN_FAILED",
      entityType: "User",
      entityId: user._id,
      meta: { reason: "locked" },
    });
    throw new AppError(423, lockedMessage(retryAfterSeconds), "ACCOUNT_LOCKED", { retryAfterSeconds });
  }

  const passwordOk = await bcrypt.compare(password, user.passwordHash);
  if (!passwordOk) {
    // $inc is atomic, so parallel guesses cannot slip past the limit
    const updated = await UserModel.findByIdAndUpdate(user._id, { $inc: { failedLoginCount: 1 } }, { new: true });
    if (updated && updated.failedLoginCount >= MAX_FAILED_LOGINS) {
      const lockUntil = new Date(now + LOCK_MINUTES * 60 * 1000);
      await UserModel.updateOne({ _id: user._id }, { $set: { lockUntil, failedLoginCount: 0 } });
      await recordAudit({
        req,
        actor: actorOf(user),
        action: "ACCOUNT_LOCKED",
        entityType: "User",
        entityId: user._id,
        meta: { minutes: LOCK_MINUTES },
      });
      throw new AppError(423, lockedMessage(LOCK_MINUTES * 60), "ACCOUNT_LOCKED", {
        retryAfterSeconds: LOCK_MINUTES * 60,
      });
    }
    await recordAudit({
      req,
      actor: actorOf(user),
      action: "LOGIN_FAILED",
      entityType: "User",
      entityId: user._id,
      meta: { reason: "wrong_password" },
    });
    throw new AppError(401, INVALID_CREDENTIALS, "INVALID_CREDENTIALS");
  }

  // Checked only after the correct password, so this does not help anyone guess emails
  if (!user.isActive) {
    await recordAudit({
      req,
      actor: actorOf(user),
      action: "LOGIN_FAILED",
      entityType: "User",
      entityId: user._id,
      meta: { reason: "deactivated" },
    });
    throw new AppError(
      403,
      "This account has been deactivated. Please contact the hospital administrator.",
      "ACCOUNT_DISABLED",
    );
  }

  await UserModel.updateOne(
    { _id: user._id },
    { $set: { failedLoginCount: 0, lockUntil: null, lastLoginAt: new Date() } },
  );
  const session = await issueSession(user, req);
  await recordAudit({
    req,
    actor: actorOf(user),
    action: "LOGIN",
    entityType: "User",
    entityId: user._id,
    meta: { sessionId: session.sessionId },
  });
  return { user: toPublicUser(user), ...session };
};

const lockedMessage = (seconds: number) =>
  `Too many failed attempts. For your security this account is locked for ${Math.ceil(seconds / 60)} more minute(s).`;

// ---------------------------------------------------------------- refresh (rotation)

export const refresh = async (rawToken: string | undefined, req: Request) => {
  if (!rawToken) throw new AppError(401, "Your session has ended. Please sign in again.", "SESSION_EXPIRED");

  const current = await RefreshTokenModel.findOne({ tokenHash: hashToken(rawToken) });
  if (!current || current.expiresAt.getTime() <= Date.now()) {
    throw new AppError(401, "Your session has ended. Please sign in again.", "SESSION_EXPIRED");
  }

  if (current.revokedAt) {
    // Only a token that was replaced by rotation signals theft. Tokens revoked by
    // logout, deactivation or an earlier detection simply mean "session over".
    if (current.revokedReason !== "rotated") {
      throw new AppError(401, "You have been signed out. Please sign in again.", "SESSION_REVOKED");
    }
    // A rotated token presented a few seconds later is usually two browser tabs
    // refreshing at once — not an attack. Outside that window it means the token
    // was copied: someone is replaying an old token, so end ALL sessions of the user.
    const graceMs = env.REFRESH_REUSE_GRACE_SECONDS * 1000;
    const benign = Date.now() - current.revokedAt.getTime() < graceMs;
    if (!benign) {
      await revokeAllSessions(String(current.user), "reuse_detected");
      // Record whose account was targeted (the request itself may come from the attacker)
      const victim = (await UserModel.findById(current.user)) as UserDocument | null;
      await recordAudit({
        req,
        actor: victim ? actorOf(victim) : null,
        action: "TOKEN_REUSE_DETECTED",
        entityType: "User",
        entityId: current.user,
        meta: { sessionId: current.sessionId },
      });
      throw new AppError(
        401,
        "For your security you have been signed out on all devices. Please sign in again.",
        "SESSION_REVOKED",
      );
    }
    throw new AppError(401, "Your session was refreshed in another tab. Please retry.", "SESSION_EXPIRED");
  }

  const user = (await UserModel.findById(current.user)) as UserDocument | null;
  if (!user || !user.isActive) {
    await revokeAllSessions(String(current.user), "user_inactive");
    throw new AppError(401, "This account is no longer active.", "ACCOUNT_DISABLED");
  }

  const next = await issueSession(user, req, current.sessionId);
  // Conditional update: only one concurrent refresh can win the rotation
  const rotated = await RefreshTokenModel.findOneAndUpdate(
    { _id: current._id, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: "rotated", replacedBy: next.refreshTokenId } },
  );
  if (!rotated) {
    await RefreshTokenModel.updateOne(
      { _id: next.refreshTokenId },
      { $set: { revokedAt: new Date(), revokedReason: "race" } },
    );
    throw new AppError(401, "Your session was refreshed in another tab. Please retry.", "SESSION_EXPIRED");
  }
  return { user: toPublicUser(user), ...next };
};

// ---------------------------------------------------------------- logout

// Uses the refresh cookie, so signing out works even after the access token expired
export const logout = async (req: Request, rawRefreshToken?: string) => {
  if (!rawRefreshToken) return;
  const token = await RefreshTokenModel.findOne({ tokenHash: hashToken(rawRefreshToken) });
  if (!token) return;
  await RefreshTokenModel.updateMany(
    { sessionId: token.sessionId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: "logout" } },
  );
  const user = (await UserModel.findById(token.user)) as UserDocument | null;
  await recordAudit({
    req,
    actor: user ? actorOf(user) : null,
    action: "LOGOUT",
    entityType: "User",
    entityId: token.user,
    meta: { sessionId: token.sessionId },
  });
};

export const logoutAll = async (req: Request) => {
  const user = req.user!;
  await revokeAllSessions(user.id, "logout_all");
  await recordAudit({ req, action: "LOGOUT_ALL", entityType: "User", entityId: user.id });
};

// ---------------------------------------------------------------- me / change password

export const getMe = async (userId: string) => {
  const user = (await UserModel.findById(userId)) as UserDocument | null;
  if (!user) throw new AppError(401, "Please sign in again.", "UNAUTHORIZED");
  return toPublicUser(user);
};

export const changePassword = async (req: Request, currentPassword: string, newPassword: string) => {
  const me = req.user!;
  const user = (await UserModel.findById(me.id).select("+passwordHash")) as UserDocument | null;
  if (!user) throw new AppError(401, "Please sign in again.", "UNAUTHORIZED");

  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
    throw new AppError(400, "Your current password is incorrect.", "VALIDATION_ERROR", [
      { path: "body.currentPassword", message: "Current password is incorrect" },
    ]);
  }
  if (await bcrypt.compare(newPassword, user.passwordHash)) {
    throw new AppError(400, "Choose a password different from your current one.", "VALIDATION_ERROR", [
      { path: "body.newPassword", message: "New password must be different from the current one" },
    ]);
  }

  user.passwordHash = await hashPassword(newPassword);
  user.passwordChangedAt = new Date();
  user.mustChangePassword = false;
  user.updatedBy = user._id;
  await user.save();

  // Anyone who knew the old password is signed out everywhere else
  await revokeAllSessions(me.id, "password_changed", me.sessionId);
  await recordAudit({ req, action: "PASSWORD_CHANGE", entityType: "User", entityId: me.id });
  return toPublicUser(user);
};

export const authService = { login, refresh, logout, logoutAll, getMe, changePassword };
