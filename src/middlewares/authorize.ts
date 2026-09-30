import { NextFunction, Request, Response } from "express";
import { Permission, roleHasPermission } from "../config/permissions";
import AppError from "../errors/AppError";
import { recordAudit } from "../modules/audit/audit.service";

const forbidden = () => new AppError(403, "You don't have permission to do this.", "FORBIDDEN");

/**
 * Route-level authorization. Use after `authenticate()`:
 *   router.post("/", authenticate(), requirePermission("user:manage"), controller)
 * A denial answers 403 in the standard error format AND is written to the audit log.
 */
export const requireAnyPermission =
  (permissions: Permission[]) => async (req: Request, _res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) return next(new AppError(401, "Please sign in to continue.", "UNAUTHORIZED"));
    if (permissions.some((p) => roleHasPermission(user.role, p))) return next();

    await recordAudit({
      req,
      action: "PERMISSION_DENIED",
      entityType: "Route",
      meta: { required: permissions, method: req.method, path: req.originalUrl },
    });
    next(forbidden());
  };

export const requirePermission = (permission: Permission) => requireAnyPermission([permission]);

/**
 * OBJECT-LEVEL authorization — the pattern later phases use.
 *
 * A permission answers "may doctors read medical records at all?". Object-level
 * rules answer "may THIS doctor read THIS patient's record?" and can only be
 * checked after loading the record, so they live in the SERVICE:
 *
 *   const visit = await VisitModel.findById(id);
 *   await assertCanAccess(req, visit.doctor.equals(req.user.doctorProfile), { entityType: "Visit", entityId: id });
 *
 * Tips: filter list queries by owner (`{ doctor: me }`) instead of checking row by
 * row, and answer 404 instead of 403 when even the record's existence is private.
 */
export const assertCanAccess = async (
  req: Request,
  allowed: boolean,
  target: { entityType: string; entityId?: string },
): Promise<void> => {
  if (allowed) return;
  await recordAudit({
    req,
    action: "PERMISSION_DENIED",
    entityType: target.entityType,
    entityId: target.entityId,
    meta: { reason: "object_level", path: req.originalUrl },
  });
  throw forbidden();
};
