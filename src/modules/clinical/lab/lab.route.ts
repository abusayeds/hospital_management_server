import express, { Request, Response } from "express";
import { z } from "zod";
import { authenticate } from "../../../middlewares/authenticate";
import { requireAnyPermission, requirePermission } from "../../../middlewares/authorize";
import validateRequest, { objectIdSchema } from "../../../middlewares/validateRequest";
import { DATE_PATTERN } from "../../../utils/date";
import catchAsync from "../../../utils/catchAsync";
import sendResponse from "../../../utils/sendResponse";
import { labReportPdf } from "./lab.pdf";
import { labService } from "./lab.service";
import { LAB_STATUSES, LabStatus } from "./labOrder.model";

// ---------------------------------------------------------------- validation

const idParams = z.object({ id: objectIdSchema });
const idSchema = z.object({ params: idParams });
const reasonSchema = z.object({
  params: idParams,
  body: z.object({ reason: z.string().trim().min(3, "Write a reason").max(300) }).strict(),
});
const createSchema = z.object({
  body: z
    .object({
      visitId: objectIdSchema,
      labTestIds: z.array(objectIdSchema).min(1, "Choose at least one test").max(30),
      priority: z.enum(["routine", "urgent"]).optional(),
      note: z.string().trim().max(500).optional(),
    })
    .strict(),
});
const resultsSchema = z.object({
  params: idParams,
  body: z
    .object({
      tests: z
        .array(
          z
            .object({
              labTestId: objectIdSchema,
              results: z.array(z.object({ name: z.string().min(1).max(100), value: z.string().max(200) }).strict()),
              comment: z.string().trim().max(500).optional(),
            })
            .strict(),
        )
        .min(1),
    })
    .strict(),
});
const listSchema = z.object({
  query: z.object({
    status: z
      .string()
      .optional()
      .transform((v) =>
        v ? v.split(",").filter((s): s is LabStatus => (LAB_STATUSES as readonly string[]).includes(s)) : [],
      ),
    q: z.string().trim().max(100).optional(),
    date: z.string().regex(DATE_PATTERN).optional(),
    mine: z
      .enum(["true", "false"])
      .optional()
      .transform((v) => v === "true"),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  }),
});

// ---------------------------------------------------------------- controllers

const ok = (res: Response, message: string, data: unknown, statusCode = 200) =>
  sendResponse(res, { statusCode, success: true, message, data });

const action = (fn: (req: Request) => Promise<unknown>, message: string) =>
  catchAsync(async (req: Request, res: Response) => ok(res, message, await fn(req)));

const list = catchAsync(async (req: Request, res: Response) => {
  const { items, pagination } = await labService.listOrders(req, req.query as never);
  sendResponse(res, { statusCode: 200, success: true, message: "Lab orders", data: items, pagination });
});

const report = catchAsync(async (req: Request, res: Response) => {
  const { pdf, fileName } = await labReportPdf(req, req.params.id);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
  res.setHeader("Cache-Control", "no-store");
  res.send(pdf);
});

// ---------------------------------------------------------------- routers

/** Mounted at /lab-orders */
const router = express.Router();
router.use(authenticate());

const lab = requirePermission("lab_result:create");
router.get("/board", requirePermission("lab_order:read"), action(labService.labBoard, "Lab board"));
router.get("/", requireAnyPermission(["lab_order:read", "lab_order:create"]), validateRequest(listSchema), list);
router.post(
  "/",
  requirePermission("lab_order:create"),
  validateRequest(createSchema),
  catchAsync(async (req: Request, res: Response) =>
    ok(res, "Tests sent to the lab", await labService.orderTests(req, req.body), 201),
  ),
);
router.get(
  "/:id",
  requireAnyPermission(["lab_order:read", "lab_report:read"]),
  validateRequest(idSchema),
  action((req) => labService.getOrder(req, req.params.id), "Lab order"),
);
router.get(
  "/:id/report.pdf",
  requireAnyPermission(["lab_report:read", "lab_report:deliver"]),
  validateRequest(idSchema),
  report,
);
router.post(
  "/:id/collect",
  lab,
  validateRequest(idSchema),
  action((req) => labService.collectSample(req, req.params.id), "Sample collected"),
);
router.patch(
  "/:id/results",
  lab,
  validateRequest(resultsSchema),
  action((req) => labService.saveResults(req, req.params.id, req.body), "Results saved"),
);
router.post(
  "/:id/submit",
  lab,
  validateRequest(idSchema),
  action((req) => labService.submitForVerification(req, req.params.id), "Sent for verification"),
);
router.post(
  "/:id/verify",
  requirePermission("lab_report:verify"),
  validateRequest(idSchema),
  action((req) => labService.verifyResults(req, req.params.id), "Report verified and released"),
);
router.post(
  "/:id/reject",
  requirePermission("lab_report:verify"),
  validateRequest(reasonSchema),
  action((req) => labService.rejectResults(req, req.params.id, req.body.reason), "Sent back for correction"),
);
router.post(
  "/:id/deliver",
  requirePermission("lab_report:deliver"),
  validateRequest(idSchema),
  action((req) => labService.deliverReport(req, req.params.id), "Report handed over"),
);
router.post(
  "/:id/cancel",
  requireAnyPermission(["lab_result:create", "lab_order:create"]),
  validateRequest(reasonSchema),
  action((req) => labService.cancelOrder(req, req.params.id, req.body.reason), "Order cancelled"),
);

/** Mounted at /patients */
const patientRouter = express.Router();
patientRouter.get(
  "/:id/lab-orders",
  authenticate(),
  requireAnyPermission(["lab_report:read"]),
  validateRequest(idSchema),
  action((req) => labService.patientLabOrders(req, req.params.id), "Lab history"),
);

export const LabRoutes = { router, patientRouter };
