import express, { Request, Response } from "express";
import { z } from "zod";
import { authenticate } from "../../middlewares/authenticate";
import { requirePermission } from "../../middlewares/authorize";
import validateRequest, { objectIdSchema } from "../../middlewares/validateRequest";
import catchAsync from "../../utils/catchAsync";
import { DATE_PATTERN } from "../../utils/date";
import sendResponse from "../../utils/sendResponse";
import { paginationQuery } from "../../validators/common";
import { toE164Bd } from "../../utils/phone";
import { ownDoctorScope } from "../hospital/appointment/appointment.route";
import { appointmentService } from "../hospital/appointment/appointment.service";
import { BLOOD_GROUPS, GENDERS, REGISTRATION_SOURCES } from "./patient.model";
import { patientService } from "./patient.service";

// ---------------------------------------------------------------- validation
// Accepts 01711222333, 01711-222333, +880 1711 222333 …; the service stores +8801711222333
const bdPhoneSchema = z
  .string()
  .trim()
  .refine((v) => toE164Bd(v) !== null, "Enter a valid mobile number (01XXXXXXXXX)");
const optionalPhone = bdPhoneSchema.or(z.literal(""));
const shortText = (max: number) => z.string().trim().max(max);

const patientBody = z.object({
  name: z.string().trim().min(2, "Enter the patient's name").max(100),
  nameBn: shortText(100).optional(),
  gender: z.enum(GENDERS),
  dateOfBirth: z
    .string()
    .regex(DATE_PATTERN, "use YYYY-MM-DD")
    .refine((d) => d <= new Date().toISOString().slice(0, 10), "cannot be in the future")
    .optional(),
  ageYears: z.number().int().min(0).max(120).optional(),
  phone: bdPhoneSchema,
  altPhone: optionalPhone.optional(),
  address: z
    .object({ area: shortText(150).optional(), upazila: shortText(60).optional(), district: shortText(60).optional() })
    .optional(),
  bloodGroup: z.enum(BLOOD_GROUPS).or(z.literal("")).optional(),
  allergies: z.array(shortText(60)).max(20).optional(),
  chronicConditions: z.array(shortText(80)).max(20).optional(),
  emergencyContact: z
    .object({ name: shortText(100).optional(), phone: optionalPhone.optional(), relation: shortText(40).optional() })
    .optional(),
  // Bangladesh NID: 10, 13 or 17 digits
  nid: z
    .string()
    .trim()
    .regex(/^(\d{10}|\d{13}|\d{17})$/, "NID must be 10, 13 or 17 digits")
    .or(z.literal(""))
    .optional(),
  notes: shortText(1000).optional(),
});

const idParams = z.object({ id: objectIdSchema });
const listSchema = z.object({ query: z.object({ q: z.string().trim().max(100).optional(), ...paginationQuery }) });
const createSchema = z.object({
  body: patientBody.extend({
    registrationSource: z.enum(REGISTRATION_SOURCES).optional(),
    // Reception saw the duplicate warning and confirmed this is a different person
    allowDuplicate: z.boolean().optional(),
  }),
});
const updateSchema = z.object({ params: idParams, body: patientBody.partial() });
const idSchema = z.object({ params: idParams });
const historySchema = z.object({ params: idParams, query: z.object({ ...paginationQuery }) });

// ---------------------------------------------------------------- controller
const list = catchAsync(async (req: Request, res: Response) => {
  const { items, pagination } = await patientService.searchPatients(req.query as never);
  const view = patientService.viewFor(req.user!.role);
  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Patients",
    data: items.map((p) => patientService.serializePatient(p, view)),
    pagination,
  });
});

const create = catchAsync(async (req: Request, res: Response) => {
  const { allowDuplicate, ...input } = req.body;
  const doc = await patientService.createPatient(input, { req, allowDuplicate });
  sendResponse(res, {
    statusCode: 201,
    success: true,
    message: "Patient registered",
    data: patientService.serializePatient(doc, patientService.viewFor(req.user!.role)),
  });
});

const get = catchAsync(async (req: Request, res: Response) => {
  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Patient",
    data: await patientService.getPatientForView(req, req.params.id),
  });
});

const update = catchAsync(async (req: Request, res: Response) => {
  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Patient updated",
    data: await patientService.updatePatient(req, req.params.id, req.body),
  });
});

// A doctor only sees this patient's appointments with THEM (same rule as /appointments)
const appointments = catchAsync(async (req: Request, res: Response) => {
  const { page, limit } = req.query as unknown as { page: number; limit: number };
  const { items, pagination } = await appointmentService.listAppointments({
    patientId: req.params.id,
    page,
    limit,
    restrictToDoctorId: await ownDoctorScope(req),
  });
  sendResponse(res, { statusCode: 200, success: true, message: "Patient appointments", data: items, pagination });
});

// ---------------------------------------------------------------- routes
const router = express.Router();
router.use(authenticate());
router.get("/", requirePermission("patient:read_basic"), validateRequest(listSchema), list);
router.post("/", requirePermission("patient:create"), validateRequest(createSchema), create);
router.get("/:id", requirePermission("patient:read_basic"), validateRequest(idSchema), get);
router.get("/:id/appointments", requirePermission("appointment:read"), validateRequest(historySchema), appointments);
router.patch("/:id", requirePermission("patient:update"), validateRequest(updateSchema), update);

export const PatientRoutes = router;
