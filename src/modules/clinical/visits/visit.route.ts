import express, { Request, Response } from "express";
import { z } from "zod";
import { authenticate } from "../../../middlewares/authenticate";
import { requirePermission } from "../../../middlewares/authorize";
import validateRequest, { objectIdSchema } from "../../../middlewares/validateRequest";
import { DOSE_PATTERN, MEAL_TIMINGS } from "../../../shared/clinical-rules";
import { DATE_PATTERN } from "../../../utils/date";
import catchAsync from "../../../utils/catchAsync";
import sendResponse from "../../../utils/sendResponse";
import { MEDICINE_ROUTES } from "./visit.model";
import { prescriptionPdf } from "./prescription.pdf";
import { visitService } from "./visit.service";

// ---------------------------------------------------------------- validation

const str = (max: number) => z.string().trim().max(max);

const itemSchema = z
  .object({
    medicineId: objectIdSchema.nullable().optional(),
    brandName: str(150).min(1, "Medicine name is required"),
    genericName: str(150).optional(),
    strength: str(60).optional(),
    form: str(40).optional(),
    dosePattern: str(30).regex(DOSE_PATTERN, 'Dose looks wrong — use a pattern like "1+0+1"'),
    timing: z.enum(MEAL_TIMINGS).nullable().optional(),
    durationDays: z
      .union([z.literal("continue"), z.coerce.number().int().min(1).max(365)])
      .nullable()
      .optional(),
    route: z.enum(MEDICINE_ROUTES as [string, ...string[]]).optional(),
    instructionsEn: str(300).optional(),
    instructionsBn: str(300).optional(),
    note: str(200).optional(),
  })
  .strict();

const investigationSchema = z
  .object({ labTestId: objectIdSchema.nullable().optional(), name: str(150).min(1), note: str(200).optional() })
  .strict();

const patchBody = z
  .object({
    chiefComplaints: z.array(str(200).min(1)).max(20),
    historyOfPresentIllness: str(6000),
    pastHistory: str(2000),
    examination: str(3000),
    provisionalDiagnosis: str(500),
    finalDiagnosis: str(500),
    investigations: z.array(investigationSchema).max(30),
    prescription: z.array(itemSchema).max(30),
    adviceEn: str(2000),
    adviceBn: str(2000),
    followUp: z
      .object({ date: z.string().regex(DATE_PATTERN).nullable().optional(), note: str(200).optional() })
      .strict()
      .nullable(),
    referral: z
      .object({ to: str(200).optional(), reason: str(300).optional() })
      .strict()
      .nullable(),
    aiSummaryUsed: z.boolean(),
    allergyOverrides: z
      .array(
        z
          .object({
            medicine: str(150).min(1),
            allergy: str(150).min(1),
            reason: str(300).min(5, "Write why this medicine is still needed"),
          })
          .strict(),
      )
      .max(10),
  })
  .partial()
  .strict();

const templateBody = z
  .object({
    name: str(80).min(1, "Give the template a name"),
    diagnosis: str(500).optional(),
    items: z.array(itemSchema).max(30),
    adviceEn: str(2000).optional(),
    adviceBn: str(2000).optional(),
    investigations: z.array(investigationSchema).max(30).optional(),
  })
  .strict();

const idParams = z.object({ id: objectIdSchema });
const idSchema = z.object({ params: idParams });
const patchSchema = z.object({ params: idParams, body: patchBody });
const addendumSchema = z.object({
  params: idParams,
  body: z
    .object({
      text: str(3000).min(3, "Write the correction"),
      reason: str(300).min(3, "Write why the record is being corrected"),
    })
    .strict(),
});
const createTemplateSchema = z.object({ body: templateBody });
const updateTemplateSchema = z.object({ params: idParams, body: templateBody.partial().strict() });

// ---------------------------------------------------------------- controllers

const ok = (res: Response, message: string, data: unknown, statusCode = 200) =>
  sendResponse(res, { statusCode, success: true, message, data });

const start = catchAsync(async (req: Request, res: Response) =>
  ok(res, "Visit opened", await visitService.startVisit(req, req.params.id), 201),
);
const getForAppointment = catchAsync(async (req: Request, res: Response) =>
  ok(res, "Visit", await visitService.getVisitForAppointment(req, req.params.id)),
);
const getOne = catchAsync(async (req: Request, res: Response) =>
  ok(res, "Visit", await visitService.getVisit(req, req.params.id)),
);
const update = catchAsync(async (req: Request, res: Response) =>
  ok(res, "Visit saved", await visitService.updateVisit(req, req.params.id, req.body)),
);
const close = catchAsync(async (req: Request, res: Response) =>
  ok(res, "Visit closed", await visitService.closeVisit(req, req.params.id)),
);
const addendum = catchAsync(async (req: Request, res: Response) =>
  ok(res, "Addendum added", await visitService.addAddendum(req, req.params.id, req.body), 201),
);
const today = catchAsync(async (req: Request, res: Response) => ok(res, "Today", await visitService.doctorToday(req)));
const emr = catchAsync(async (req: Request, res: Response) =>
  ok(res, "Medical record", await visitService.patientEmr(req, req.params.id)),
);
const listTemplates = catchAsync(async (req: Request, res: Response) =>
  ok(res, "Templates", await visitService.listTemplates(req)),
);
const createTemplate = catchAsync(async (req: Request, res: Response) =>
  ok(res, "Template saved", await visitService.createTemplate(req, req.body), 201),
);
const updateTemplate = catchAsync(async (req: Request, res: Response) =>
  ok(res, "Template saved", await visitService.updateTemplate(req, req.params.id, req.body)),
);
const deleteTemplate = catchAsync(async (req: Request, res: Response) => {
  await visitService.deleteTemplate(req, req.params.id);
  ok(res, "Template deleted", null);
});

const printPrescription = catchAsync(async (req: Request, res: Response) => {
  const { pdf, fileName } = await prescriptionPdf(req, req.params.id);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
  res.setHeader("Cache-Control", "no-store"); // medical record: never cached by browsers or proxies
  res.send(pdf);
});

// ---------------------------------------------------------------- routers

/** Mounted at /visits */
const visitRouter = express.Router();
visitRouter.use(authenticate());
// Fixed paths first, so "today" / "templates" are not read as an :id
visitRouter.get("/today", requirePermission("visit:create"), today);
visitRouter.get("/templates", requirePermission("prescription:create"), listTemplates);
visitRouter.post(
  "/templates",
  requirePermission("prescription:create"),
  validateRequest(createTemplateSchema),
  createTemplate,
);
visitRouter.patch(
  "/templates/:id",
  requirePermission("prescription:create"),
  validateRequest(updateTemplateSchema),
  updateTemplate,
);
visitRouter.delete(
  "/templates/:id",
  requirePermission("prescription:create"),
  validateRequest(idSchema),
  deleteTemplate,
);
visitRouter.get("/:id", requirePermission("visit:read"), validateRequest(idSchema), getOne);
visitRouter.get("/:id/prescription.pdf", requirePermission("visit:read"), validateRequest(idSchema), printPrescription);
visitRouter.patch("/:id", requirePermission("visit:create"), validateRequest(patchSchema), update);
visitRouter.post("/:id/close", requirePermission("visit:create"), validateRequest(idSchema), close);
visitRouter.post("/:id/addenda", requirePermission("visit:create"), validateRequest(addendumSchema), addendum);

/** Mounted at /appointments */
const appointmentRouter = express.Router();
appointmentRouter.post(
  "/:id/visit",
  authenticate(),
  requirePermission("visit:create"),
  validateRequest(idSchema),
  start,
);
appointmentRouter.get(
  "/:id/visit",
  authenticate(),
  requirePermission("visit:read"),
  validateRequest(idSchema),
  getForAppointment,
);

/** Mounted at /patients */
const patientRouter = express.Router();
patientRouter.get("/:id/emr", authenticate(), requirePermission("visit:read"), validateRequest(idSchema), emr);

export const VisitRoutes = { visitRouter, appointmentRouter, patientRouter };
