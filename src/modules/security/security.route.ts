import express, { Request, Response } from "express";
import { z } from "zod";
import { authenticate } from "../../middlewares/authenticate";
import { requirePermission } from "../../middlewares/authorize";
import validateRequest from "../../middlewares/validateRequest";
import catchAsync from "../../utils/catchAsync";
import sendResponse from "../../utils/sendResponse";
import { securityOverview, unblockIp } from "./security.service";

const ipSchema = z.object({
  params: z.object({
    ip: z
      .string()
      .trim()
      .min(3)
      .max(64)
      .regex(/^[0-9a-fA-F:.]+$/, "Not an IP address"),
  }),
});

const overview = catchAsync(async (_req: Request, res: Response) =>
  sendResponse(res, { statusCode: 200, success: true, message: "Security overview", data: await securityOverview() }),
);
const unblock = catchAsync(async (req: Request, res: Response) =>
  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "IP unblocked",
    data: await unblockIp(req, req.params.ip),
  }),
);

// /security — read with audit:read, lift a block with settings:manage
const router = express.Router();
router.use(authenticate());
router.get("/overview", requirePermission("audit:read"), overview);
router.delete("/blocks/:ip", requirePermission("settings:manage"), validateRequest(ipSchema), unblock);
export const SecurityRoutes = router;
