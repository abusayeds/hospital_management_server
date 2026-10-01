import express, { Request, Response } from "express";
import { z } from "zod";
import { authenticate } from "../../middlewares/authenticate";
import { requirePermission } from "../../middlewares/authorize";
import validateRequest, { objectIdSchema } from "../../middlewares/validateRequest";
import catchAsync from "../../utils/catchAsync";
import { DATE_PATTERN, TIME_PATTERN } from "../../utils/date";
import { toE164Bd } from "../../utils/phone";
import sendResponse from "../../utils/sendResponse";
import AppError from "../../errors/AppError";
import { getSettings } from "../hospital/settings/settings.service";
import * as svc from "./automation.service";
import { JOB_STATUSES } from "./models/job.model";
import { OUTBOX_CHANNELS, OUTBOX_SOURCES, OUTBOX_STATUSES } from "./models/outbox.model";
import { TEMPLATE_CATEGORIES, VARIABLE_TYPES } from "./models/template.model";
import { updateRuleSettings } from "./rules/config";
import { listTemplates, previewTemplate, rollbackTemplate, updateTemplate } from "./templates/template.service";

/**
 * Mounted at /automation. automation:read (super admin, management) sees everything; automation:manage
 * (super admin) changes rules, templates and settings and retries / cancels messages.
 */
const router = express.Router();
router.use(authenticate());

const ok = (res: Response, message: string, data: unknown) =>
  sendResponse(res, { statusCode: 200, success: true, message, data });
const READ = requirePermission("automation:read");
const MANAGE = requirePermission("automation:manage");

const idSchema = z.object({ params: z.object({ id: objectIdSchema }) });
const keySchema = z.object({ params: z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{2,60}$/) }) });
const page = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
};
const phoneBody = z.object({
  phone: z.string().trim().min(8).max(20),
  language: z.enum(["bn", "en"]).default("bn"),
});
const bdPhone = (raw: string) => {
  const p = toE164Bd(raw);
  if (!p) throw new AppError(400, "Enter a Bangladeshi mobile number (01XXXXXXXXX).", "VALIDATION_ERROR");
  return p;
};

// ------------------------------------------------------------------ rules

router.get(
  "/rules",
  READ,
  catchAsync(async (_req, res) => ok(res, "Automation rules", await svc.listRules())),
);

router.patch(
  "/rules/:key",
  MANAGE,
  validateRequest(
    keySchema.extend({
      body: z.object({ enabled: z.boolean().optional(), config: z.record(z.unknown()).optional() }).strict(),
    }),
  ),
  catchAsync(async (req: Request, res: Response) =>
    ok(res, "Rule saved", await updateRuleSettings(req, req.params.key, req.body)),
  ),
);

router.post(
  "/rules/:key/run",
  MANAGE,
  validateRequest(keySchema),
  catchAsync(async (req: Request, res: Response) => ok(res, "Planner ran", await svc.runRuleNow(req, req.params.key))),
);

router.post(
  "/rules/:key/test",
  MANAGE,
  validateRequest(keySchema.extend({ body: phoneBody.strict() })),
  catchAsync(async (req: Request, res: Response) =>
    ok(res, "Test sent", await svc.testSend(req, req.params.key, bdPhone(req.body.phone), req.body.language)),
  ),
);

// ------------------------------------------------------------------ templates

const content = {
  bodies: z.object({ bn: z.string().trim().min(1).max(1500), en: z.string().trim().min(1).max(1500) }),
  buttons: z
    .array(
      z.object({
        action: z.string().trim().min(1).max(30),
        label: z.object({ bn: z.string().trim().max(20), en: z.string().trim().max(20) }),
      }),
    )
    .max(3),
  whatsappTemplateName: z.string().trim().max(512).nullable(),
  whatsappLanguages: z.object({ bn: z.string().trim().min(2).max(10), en: z.string().trim().min(2).max(10) }),
  whatsappParams: z.array(z.string()).max(10),
  variables: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(41),
        type: z.enum(VARIABLE_TYPES),
        required: z.boolean(),
        sample: z.string().max(200),
      }),
    )
    .max(20),
};

router.get(
  "/templates",
  READ,
  validateRequest(z.object({ query: z.object({ category: z.enum(TEMPLATE_CATEGORIES).optional() }) })),
  catchAsync(async (req: Request, res: Response) =>
    ok(res, "Templates", await listTemplates(req.query.category as string | undefined)),
  ),
);

router.patch(
  "/templates/:key",
  MANAGE,
  validateRequest(
    keySchema.extend({
      body: z
        .object({ ...content, description: z.string().trim().max(300), isActive: z.boolean() })
        .partial()
        .strict(),
    }),
  ),
  catchAsync(async (req: Request, res: Response) =>
    ok(res, "Template saved", await updateTemplate(req, req.params.key, req.body)),
  ),
);

router.post(
  "/templates/:key/rollback",
  MANAGE,
  validateRequest(keySchema.extend({ body: z.object({ version: z.number().int().min(1) }).strict() })),
  catchAsync(async (req: Request, res: Response) =>
    ok(res, "Template restored", await rollbackTemplate(req, req.params.key, req.body.version)),
  ),
);

router.post(
  "/templates/preview",
  READ,
  validateRequest(
    z.object({
      body: z.object({ ...content, values: z.record(z.string().max(200)).optional() }).strict(),
    }),
  ),
  catchAsync(async (req: Request, res: Response) => {
    const { values, ...tpl } = req.body;
    const { messageNumerals } = await getSettings();
    ok(res, "Preview", previewTemplate(tpl, messageNumerals, values));
  }),
);

// ------------------------------------------------------------------ outbox

const outboxFilters = {
  from: z.string().regex(DATE_PATTERN).optional(),
  to: z.string().regex(DATE_PATTERN).optional(),
  channel: z.enum(OUTBOX_CHANNELS).optional(),
  status: z.enum(OUTBOX_STATUSES).optional(),
  source: z.enum(OUTBOX_SOURCES).optional(),
  ruleKey: z.string().max(60).optional(),
  patientId: objectIdSchema.optional(),
  q: z.string().trim().max(100).optional(),
};

router.get(
  "/outbox",
  READ,
  validateRequest(z.object({ query: z.object({ ...outboxFilters, ...page }) })),
  catchAsync(async (req: Request, res: Response) => {
    const { items, pagination } = await svc.listOutbox(req.query as never);
    sendResponse(res, { statusCode: 200, success: true, message: "Outbox", data: items, pagination });
  }),
);

router.get(
  "/outbox/export.csv",
  READ,
  validateRequest(z.object({ query: z.object(outboxFilters) })),
  catchAsync(async (req: Request, res: Response) => {
    const csv = await svc.exportOutboxCsv(req.query as never);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="outbox-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(String.fromCharCode(0xfeff) + csv); // BOM so Excel reads Bangla correctly
  }),
);

router.get(
  "/outbox/:id",
  READ,
  validateRequest(idSchema),
  catchAsync(async (req: Request, res: Response) => ok(res, "Message", await svc.getOutbox(req.params.id))),
);
router.post(
  "/outbox/:id/retry",
  MANAGE,
  validateRequest(idSchema),
  catchAsync(async (req: Request, res: Response) => ok(res, "Retried", await svc.retryOutbox(req, req.params.id))),
);
router.post(
  "/outbox/:id/cancel",
  MANAGE,
  validateRequest(idSchema),
  catchAsync(async (req: Request, res: Response) => ok(res, "Cancelled", await svc.cancelOutbox(req, req.params.id))),
);
router.post(
  "/outbox/:id/test",
  MANAGE,
  validateRequest(idSchema.extend({ body: phoneBody.pick({ phone: true }).strict() })),
  catchAsync(async (req: Request, res: Response) =>
    ok(res, "Test sent", await svc.duplicateAsTest(req, req.params.id, bdPhone(req.body.phone))),
  ),
);

// ------------------------------------------------------------------ queue, jobs, runs, health

router.get(
  "/queue",
  READ,
  validateRequest(
    z.object({
      query: z.object({
        minutes: z.coerce
          .number()
          .int()
          .min(5)
          .max(24 * 60)
          .default(60),
      }),
    }),
  ),
  catchAsync(async (req: Request, res: Response) =>
    ok(res, "Scheduled queue", await svc.upcomingQueue(Number(req.query.minutes))),
  ),
);

router.get(
  "/jobs",
  READ,
  validateRequest(
    z.object({
      query: z.object({
        ruleKey: z.string().max(60).optional(),
        status: z.enum(JOB_STATUSES).optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        ...page,
      }),
    }),
  ),
  catchAsync(async (req: Request, res: Response) => {
    const { items, pagination } = await svc.listJobs(req.query as never);
    sendResponse(res, { statusCode: 200, success: true, message: "Jobs", data: items, pagination });
  }),
);
router.get(
  "/jobs/:id",
  READ,
  validateRequest(idSchema),
  catchAsync(async (req: Request, res: Response) => ok(res, "Job", await svc.getJob(req.params.id))),
);
router.post(
  "/jobs/:id/cancel",
  MANAGE,
  validateRequest(idSchema.extend({ body: z.object({ reason: z.string().trim().max(200).optional() }).strict() })),
  catchAsync(async (req: Request, res: Response) =>
    ok(res, "Job cancelled", await svc.cancelJobAction(req, req.params.id, req.body.reason)),
  ),
);
router.post(
  "/jobs/:id/retry",
  MANAGE,
  validateRequest(idSchema),
  catchAsync(async (req: Request, res: Response) =>
    ok(res, "Job retried", await svc.retryJobAction(req, req.params.id)),
  ),
);

router.get(
  "/runs",
  READ,
  validateRequest(
    z.object({
      query: z.object({
        ruleKey: z.string().max(60).optional(),
        kind: z.enum(["planner", "event", "dispatch", "preview"]).optional(),
        withErrors: z
          .enum(["true", "false"])
          .optional()
          .transform((v) => v === "true"),
        ...page,
      }),
    }),
  ),
  catchAsync(async (req: Request, res: Response) => {
    const { items, pagination } = await svc.listRuns(req.query as never);
    sendResponse(res, { statusCode: 200, success: true, message: "Runs", data: items, pagination });
  }),
);

router.get(
  "/health",
  READ,
  catchAsync(async (_req, res) => ok(res, "Automation health", await svc.health())),
);

// ------------------------------------------------------------------ settings + preview world

router.get(
  "/settings",
  READ,
  catchAsync(async (_req, res) => ok(res, "Automation settings", await svc.getAutomationSettings())),
);
router.patch(
  "/settings",
  MANAGE,
  validateRequest(
    z.object({
      body: z
        .object({
          automationPaused: z.boolean(),
          quietHoursStart: z.string().regex(TIME_PATTERN, "Use HH:mm"),
          quietHoursEnd: z.string().regex(TIME_PATTERN, "Use HH:mm"),
          messageNumerals: z.enum(["bn", "en"]),
          automationDailyBudget: z.number().int().min(0).max(100_000),
          perPhoneDailyCap: z.number().int().min(1).max(20),
          dedupeWindowMinutes: z.number().int().min(0).max(1440),
          smsFallbackEnabled: z.boolean(),
          failureAlertThreshold: z.number().int().min(1).max(1000),
        })
        .partial()
        .strict(),
    }),
  ),
  catchAsync(async (req: Request, res: Response) =>
    ok(res, "Automation settings saved", await svc.updateAutomationSettings(req, req.body)),
  ),
);

router.post(
  "/preview-world",
  MANAGE,
  validateRequest(z.object({ body: z.object({ at: z.string().datetime() }).strict() })),
  catchAsync(async (req: Request, res: Response) => {
    const at = new Date(req.body.at);
    const now = Date.now();
    if (at.getTime() < now || at.getTime() > now + 24 * 3600e3)
      throw new AppError(400, "Pick a time within the next 24 hours.", "VALIDATION_ERROR");
    ok(res, "Preview", await svc.previewWorld(at));
  }),
);

// ------------------------------------------------------------------ patient profile "Messages" tab

router.get(
  "/patients/:id/messages",
  requirePermission("patient:read_basic"),
  validateRequest(idSchema),
  catchAsync(async (req: Request, res: Response) =>
    ok(res, "Patient messages", await svc.patientMessages(req, req.params.id)),
  ),
);

export const AutomationRoutes = router;
