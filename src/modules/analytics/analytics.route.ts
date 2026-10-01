import express, { Request, Response } from "express";
import { z } from "zod";
import { authenticate } from "../../middlewares/authenticate";
import { requirePermission } from "../../middlewares/authorize";
import validateRequest, { objectIdSchema } from "../../middlewares/validateRequest";
import catchAsync from "../../utils/catchAsync";
import { DATE_PATTERN } from "../../utils/date";
import sendResponse from "../../utils/sendResponse";
import { recordAudit } from "../audit/audit.service";
import { APPOINTMENT_SOURCES } from "../hospital/appointment/appointment.model";
import { analyticsService, Filters, normalizeRange } from "./analytics.service";

// ---------------------------------------------------------------- validation
const date = z.string().regex(DATE_PATTERN, "use YYYY-MM-DD");
/** "a,b,c" → ["a","b","c"] (query strings carry multi-select filters comma-separated) */
const csvList = <T extends z.ZodTypeAny>(item: T) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean)
        : undefined,
    )
    .pipe(z.array(item).max(50).optional());

const filterQuery = {
  from: date.optional(),
  to: date.optional(),
  doctorIds: csvList(objectIdSchema),
  departmentIds: csvList(objectIdSchema),
  sources: csvList(z.enum(APPOINTMENT_SOURCES)),
  labCategory: z.string().trim().max(60).optional(),
};
const rangeSchema = z.object({ query: z.object(filterQuery) });
const kpiSchema = z.object({ query: z.object({ date: date.optional() }) });
const trendSchema = z.object({
  query: z.object({ ...filterQuery, statuses: csvList(z.string().max(30)), lines: csvList(z.string().max(30)) }),
});
const REPORTS = [
  "doctor-stats",
  "department-stats",
  "appointments",
  "revenue",
  "lab-frequency",
  "payment-methods",
  "chat-volume",
] as const;
const exportSchema = z.object({ query: z.object({ ...filterQuery, report: z.enum(REPORTS) }) });

// ---------------------------------------------------------------- controller
const ok = (res: Response, message: string, data: unknown) =>
  sendResponse(res, { statusCode: 200, success: true, message, data });
const filters = (req: Request) => normalizeRange(req.query as unknown as Partial<Filters>);

const kpis = catchAsync(async (req: Request, res: Response) =>
  ok(res, "KPIs", await analyticsService.getKpis(req.query.date as string | undefined)),
);
const appointmentTrend = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Appointment trend",
    await analyticsService.appointmentTrend(filters(req), req.query.statuses as unknown as string[] | undefined),
  ),
);
const revenueTrend = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Revenue trend",
    await analyticsService.revenueTrend(filters(req), req.query.lines as unknown as string[] | undefined),
  ),
);
const simple = (fn: (f: Filters) => Promise<unknown>, message: string) =>
  catchAsync(async (req: Request, res: Response) => ok(res, message, await fn(filters(req))));
const queueNow = catchAsync(async (_req: Request, res: Response) =>
  ok(res, "Queue now", await analyticsService.queueNow()),
);

// ---- CSV export (management only; audited — the files hold no patient data)
const cell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  // Neutralise spreadsheet formulas (CSV injection) and quote when needed
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const toCsv = (rows: Record<string, unknown>[]) => {
  if (!rows.length) return "no data\n";
  const headers = Object.keys(rows[0]);
  return [headers.join(","), ...rows.map((r) => headers.map((h) => cell(r[h])).join(","))].join("\n") + "\n";
};
const taka = (poisha: number) => (poisha / 100).toFixed(2);

const exportCsv = catchAsync(async (req: Request, res: Response) => {
  const f = filters(req);
  const report = req.query.report as (typeof REPORTS)[number];
  let rows: Record<string, unknown>[] = [];
  if (report === "doctor-stats")
    rows = (await analyticsService.doctorStats(f)).map(({ doctorId: _id, revenue, collected, ...r }) => ({
      ...r,
      revenueTaka: taka(revenue),
      collectedTaka: taka(collected),
    }));
  else if (report === "department-stats")
    rows = (await analyticsService.departmentStats(f)).map(({ deptId: _id, ...r }) => r);
  else if (report === "appointments") rows = await analyticsService.appointmentTrend(f);
  else if (report === "revenue")
    rows = (await analyticsService.revenueTrend(f)).map((p) =>
      Object.fromEntries(
        Object.entries(p).map(([k, v]) => [k === "date" ? k : `${k}Taka`, k === "date" ? v : taka(v as number)]),
      ),
    );
  else if (report === "lab-frequency") rows = await analyticsService.labFrequency(f);
  else if (report === "payment-methods")
    rows = (await analyticsService.paymentMethods(f)).byMethod.map((m) => ({
      method: m.method,
      payments: m.count,
      amountTaka: taka(m.amount),
    }));
  else if (report === "chat-volume") rows = await analyticsService.chatVolume(f);

  await recordAudit({
    req,
    action: "EXPORT",
    entityType: "Analytics",
    meta: { report, from: f.from, to: f.to, rows: rows.length },
  });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="testolife-${report}-${f.from}_to_${f.to}.csv"`);
  res.setHeader("Cache-Control", "no-store");
  res.send("﻿" + toCsv(rows)); // BOM so Excel reads Bangla names correctly
});

// ---------------------------------------------------------------- routes
const router = express.Router();
router.use(authenticate(), requirePermission("report:operations"));
router.get("/kpis", validateRequest(kpiSchema), kpis);
router.get("/trend/appointments", validateRequest(trendSchema), appointmentTrend);
router.get("/trend/revenue", validateRequest(trendSchema), revenueTrend);
router.get("/doctor-stats", validateRequest(rangeSchema), simple(analyticsService.doctorStats, "Doctor stats"));
router.get(
  "/department-stats",
  validateRequest(rangeSchema),
  simple(analyticsService.departmentStats, "Department stats"),
);
router.get("/doctor-heatmap", validateRequest(rangeSchema), simple(analyticsService.doctorHeatmap, "Doctor heatmap"));
router.get(
  "/payment-methods",
  validateRequest(rangeSchema),
  simple(analyticsService.paymentMethods, "Payment methods"),
);
router.get("/lab-frequency", validateRequest(rangeSchema), simple(analyticsService.labFrequency, "Lab frequency"));
router.get(
  "/abnormal-findings",
  validateRequest(rangeSchema),
  simple(analyticsService.abnormalFindings, "Abnormal findings"),
);
router.get("/lead-time", validateRequest(rangeSchema), simple(analyticsService.leadTime, "Booking lead time"));
router.get("/chat-volume", validateRequest(rangeSchema), simple(analyticsService.chatVolume, "Chat volume"));
router.get("/queue/now", queueNow);
router.get("/export.csv", requirePermission("dashboard:analytics_export"), validateRequest(exportSchema), exportCsv);
export const AnalyticsRoutes = router;
