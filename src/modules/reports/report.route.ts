import express, { Request, Response } from "express";
import { z } from "zod";
import { authenticate } from "../../middlewares/authenticate";
import { requirePermission } from "../../middlewares/authorize";
import validateRequest from "../../middlewares/validateRequest";
import catchAsync from "../../utils/catchAsync";
import { addDays, DATE_PATTERN, todayInDhaka } from "../../utils/date";
import sendResponse from "../../utils/sendResponse";
import { paginationQuery } from "../../validators/common";
import { recordAudit } from "../audit/audit.service";
import { dispatchNow } from "../automation/dispatcher";
import { planJobs } from "../automation/jobs";
import { AutomationJobModel } from "../automation/models/job.model";
import { generateDailyReport, getReport, listReports } from "./dailyReport.service";

// ---------------------------------------------------------------- validation
const date = z.string().regex(DATE_PATTERN, "use YYYY-MM-DD");
const listSchema = z.object({ query: z.object({ ...paginationQuery }) });
const dateSchema = z.object({ params: z.object({ date }) });
const generateSchema = z.object({ body: z.object({ date: date.optional() }) });

// ---------------------------------------------------------------- controller
const ok = (res: Response, message: string, data: unknown, statusCode = 200) =>
  sendResponse(res, { statusCode, success: true, message, data });

const list = catchAsync(async (req: Request, res: Response) => {
  const { items, pagination } = await listReports(Number(req.query.page ?? 1), Number(req.query.limit ?? 20));
  sendResponse(res, { statusCode: 200, success: true, message: "Daily reports", data: items, pagination });
});
const get = catchAsync(async (req: Request, res: Response) =>
  ok(res, "Daily report", await getReport(req.params.date)),
);

/** "Generate now" — defaults to YESTERDAY (a complete day); replaces the stored report for that date */
const generate = catchAsync(async (req: Request, res: Response) =>
  ok(res, "Report generated", await generateDailyReport(req.body.date ?? addDays(todayInDhaka(), -1), { req }), 201),
);

/** Send the stored report again through the automation rule (in-app + configured WhatsApp phones) */
const resend = catchAsync(async (req: Request, res: Response) => {
  const reportDate = req.params.date;
  await getReport(reportDate); // 404 when there is nothing to send
  const dedupeKey = `ai-report:${reportDate}:resend:${Date.now()}`;
  await planJobs("daily_ai_report", [
    { dedupeKey, scopeType: "system", scopeId: reportDate, scheduledFor: new Date(), data: { resend: true } },
  ]);
  const job = await AutomationJobModel.findOne({ ruleKey: "daily_ai_report", dedupeKey })
    .select("_id")
    .lean<{ _id: unknown }>();
  if (job) await dispatchNow(job._id);
  await recordAudit({
    req,
    action: "UPDATE",
    entityType: "OperationalReport",
    meta: { date: reportDate, event: "resend" },
  });
  ok(res, "Report sent again", await getReport(reportDate));
});

// ---------------------------------------------------------------- routes (/reports/daily…)
const router = express.Router();
router.use("/daily", authenticate(), requirePermission("report:operations"));
router.get("/daily", validateRequest(listSchema), list);
router.post("/daily/generate", validateRequest(generateSchema), generate);
router.get("/daily/:date", validateRequest(dateSchema), get);
router.post("/daily/:date/resend", validateRequest(dateSchema), resend);
export const DailyReportRoutes = router;
