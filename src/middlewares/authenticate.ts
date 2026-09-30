import { NextFunction, Request, Response } from "express";
import { TokenExpiredError } from "jsonwebtoken";
import { permissionsForRole } from "../config/permissions";
import AppError from "../errors/AppError";
import { RefreshTokenModel } from "../modules/auth/refreshToken.model";
import { ACCESS_COOKIE, verifyAccessToken } from "../modules/auth/tokens";
import { IUser, UserModel } from "../modules/users/user.model";

type Options = {
  // Only /auth/me, /auth/change-password and logout allow a user who still has to change their password
  allowPendingPasswordChange?: boolean;
};

/**
 * Verifies the access-token cookie and loads the user on EVERY request:
 *  - the session must still exist (logout / "log out everywhere" / theft detection take effect instantly)
 *  - the user must still be active (a deactivated user is kicked out immediately)
 *  - role and permissions come from the database, not the token (role changes apply at once)
 */
export const authenticate =
  (options: Options = {}) =>
  async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const token = req.cookies?.[ACCESS_COOKIE];
      if (!token) throw new AppError(401, "Please sign in to continue.", "UNAUTHORIZED");

      let payload;
      try {
        payload = verifyAccessToken(token);
      } catch (err) {
        // The frontend reacts to SESSION_EXPIRED by silently calling /auth/refresh
        if (err instanceof TokenExpiredError) throw new AppError(401, "Your session has expired.", "SESSION_EXPIRED");
        throw new AppError(401, "Please sign in to continue.", "UNAUTHORIZED");
      }

      const [sessionAlive, user] = await Promise.all([
        RefreshTokenModel.exists({ sessionId: payload.sid, revokedAt: null, expiresAt: { $gt: new Date() } }),
        UserModel.findById(payload.sub).lean<IUser & { _id: unknown }>(),
      ]);
      if (!sessionAlive) throw new AppError(401, "You have been signed out. Please sign in again.", "SESSION_REVOKED");
      if (!user) throw new AppError(401, "Please sign in to continue.", "UNAUTHORIZED");
      if (!user.isActive) throw new AppError(401, "This account has been deactivated.", "ACCOUNT_DISABLED");

      req.user = {
        id: String(user._id),
        name: user.name,
        email: user.email,
        role: user.role,
        sessionId: payload.sid,
        mustChangePassword: user.mustChangePassword,
        permissions: permissionsForRole(user.role),
      };

      if (user.mustChangePassword && !options.allowPendingPasswordChange) {
        throw new AppError(403, "Please set a new password before continuing.", "PASSWORD_CHANGE_REQUIRED");
      }
      next();
    } catch (err) {
      next(err);
    }
  };
