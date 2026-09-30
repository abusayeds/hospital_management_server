import express, { Request, Response } from "express";
import { z } from "zod";
import { authenticate } from "../../../middlewares/authenticate";
import { requireAnyPermission, requirePermission } from "../../../middlewares/authorize";
import validateRequest, { objectIdSchema } from "../../../middlewares/validateRequest";
import { VITAL_LIMITS } from "../../../shared/clinical-rules";
import catchAsync from "../../../utils/catchAsync";
import sendResponse from "../../../utils/sendResponse";
import { loadAppointment } from "../../hospital/appointment/appointment.service";
import { assertVitalsAccess } from "../emr-access";
import { vitalsService } from "./vitals.service";

// ---------------------------------------------------------------- validation

const inRange = (key: keyof typeof VITAL_LIMITS, label: string) => {
  const { min, max, unit } = VITAL_LIMITS[key];
  return z.coerce
    .number({ invalid_type_error: `${label} must be a number` })
    .min(min, `${label} looks wrong (${min}–${max} ${unit})`)
    .max(max, `${label} looks wrong (${min}–${max} ${unit})`)
    .nullable()
    .optional();
};

const vitalsBody = z
  .object({
    bpSystolic: inRange("bpSystolic", "Systolic BP"),
    bpDiastolic: inRange("bpDiastolic", "Diastolic BP"),
    pulse: inRange("pulse", "Pulse"),
    temperatureF: inRange("temperatureF", "Temperature"),
    respiratoryRate: inRange("respiratoryRate", "Respiratory rate"),
    spo2: inRange("spo2", "SpO₂"),
    weightKg: inRange("weightKg", "Weight"),
    heightCm: inRange("heightCm", "Height"),
    bloodSugar: z
      .object({
        value: inRange("bloodSugar", "Blood sugar"),
        type: z.enum(["fasting", "random"]).nullable().optional(),
      })
      .nullable()
      .optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine((b) => (b.bpSystolic == null) === (b.bpDiastolic == null), {
    message: "Enter both systolic and diastolic BP",
    path: ["bpDiastolic"],
  })
  .refine((b) => b.bpSystolic == null || b.bpDiastolic == null || b.bpSystolic > b.bpDiastolic, {
    message: "Systolic must be higher than diastolic",
    path: ["bpSystolic"],
  });

const apptParams = z.object({ id: objectIdSchema });
const createSchema = z.object({ params: apptParams, body: vitalsBody });
const readSchema = z.object({ params: apptParams });
const worklistSchema = z.object({ query: z.object({ doctorId: objectIdSchema.optional() }) });
const patientSchema = z.object({
  params: z.object({ id: objectIdSchema }),
  query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }),
});

// ---------------------------------------------------------------- controllers

const record = catchAsync(async (req: Request, res: Response) => {
  const data = await vitalsService.recordVitals(req, req.params.id, req.body);
  sendResponse(res, { statusCode: 201, success: true, message: "Vitals recorded", data });
});

const update = catchAsync(async (req: Request, res: Response) => {
  const data = await vitalsService.updateVitals(req, req.params.id, req.body);
  sendResponse(res, { statusCode: 200, success: true, message: "Vitals updated", data });
});

const getForAppointment = catchAsync(async (req: Request, res: Response) => {
  const appt = await loadAppointment(req.params.id);
  await assertVitalsAccess(req, String(appt.patient));
  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Vitals",
    data: await vitalsService.getVitalsForAppointment(req.params.id),
  });
});

const worklist = catchAsync(async (req: Request, res: Response) => {
  const data = await vitalsService.nurseWorklist(req.query.doctorId as string | undefined);
  sendResponse(res, { statusCode: 200, success: true, message: "Today's vitals worklist", data });
});

const patientHistory = catchAsync(async (req: Request, res: Response) => {
  await assertVitalsAccess(req, req.params.id);
  const data = await vitalsService.patientVitalsHistory(req.params.id, Number(req.query.limit));
  sendResponse(res, { statusCode: 200, success: true, message: "Vitals history", data });
});

// ---------------------------------------------------------------- routers

/** Mounted at /appointments (next to the Phase 3 appointment routes) */
const appointmentRouter = express.Router();
appointmentRouter.post(
  "/:id/vitals",
  authenticate(),
  requirePermission("vitals:create"),
  validateRequest(createSchema),
  record,
);
appointmentRouter.patch(
  "/:id/vitals",
  authenticate(),
  requirePermission("vitals:create"),
  validateRequest(createSchema),
  update,
);
appointmentRouter.get(
  "/:id/vitals",
  authenticate(),
  requirePermission("vitals:read"),
  validateRequest(readSchema),
  getForAppointment,
);

/** Mounted at /vitals */
const vitalsRouter = express.Router();
vitalsRouter.get(
  "/worklist",
  authenticate(),
  requireAnyPermission(["vitals:create", "vitals:read"]),
  validateRequest(worklistSchema),
  worklist,
);

/** Mounted at /patients (clinical sub-resources of a patient) */
const patientRouter = express.Router();
patientRouter.get(
  "/:id/vitals",
  authenticate(),
  requirePermission("vitals:read"),
  validateRequest(patientSchema),
  patientHistory,
);

export const VitalsRoutes = { appointmentRouter, vitalsRouter, patientRouter };
