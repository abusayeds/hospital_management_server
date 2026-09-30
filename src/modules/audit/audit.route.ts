import express, { Request, Response } from "express";
import { authenticate } from "../../middlewares/authenticate";
import { requirePermission } from "../../middlewares/authorize";
import validateRequest from "../../middlewares/validateRequest";
import catchAsync from "../../utils/catchAsync";
import sendResponse from "../../utils/sendResponse";
import { getSecurityStats, listAuditLogs } from "./audit.query";
import { listAuditSchema } from "./audit.validation";

// Read-only on purpose: there are no update or delete endpoints for audit logs.

const list = catchAsync(async (req: Request, res: Response) => {
  const { items, pagination } = await listAuditLogs(req.query as never);
  sendResponse(res, { statusCode: 200, success: true, message: "Audit logs", data: items, pagination });
});

const stats = catchAsync(async (_req: Request, res: Response) => {
  sendResponse(res, { statusCode: 200, success: true, message: "Security stats", data: await getSecurityStats() });
});

const router = express.Router();
router.use(authenticate(), requirePermission("audit:read"));
router.get("/", validateRequest(listAuditSchema), list);
router.get("/stats", stats);

export const AuditRoutes = router;
