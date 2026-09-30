import { Request, Response } from "express";
import catchAsync from "../utils/catchAsync";
import sendResponse from "../utils/sendResponse";
import { healthService } from "../services/health.service";

// 200 when everything is up, 503 when the database is unreachable, so load
// balancers and uptime monitors can react without parsing the body.
const getHealth = catchAsync(async (_req: Request, res: Response) => {
  const report = await healthService.getHealth();
  const statusCode = report.status === "ok" ? 200 : 503;
  sendResponse(res, { statusCode, success: report.status === "ok", message: `API is ${report.status}`, data: report });
});

export const healthController = { getHealth };
