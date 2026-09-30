import express, { Request, Response } from "express";
import { z } from "zod";
import { authenticate } from "../../../middlewares/authenticate";
import { requireAnyPermission, requirePermission } from "../../../middlewares/authorize";
import validateRequest, { objectIdSchema } from "../../../middlewares/validateRequest";
import catchAsync from "../../../utils/catchAsync";
import { DATE_PATTERN, TIME_PATTERN } from "../../../utils/date";
import sendResponse from "../../../utils/sendResponse";
import { paginationQuery } from "../../../validators/common";
import { roleHasPermission } from "../../../config/permissions";
import { getAvailabilityCalendar, getDoctorSlots } from "../scheduling/scheduling.service";
import { doctorService } from "./doctor.service";

// ---------------------------------------------------------------- validation
const time = z.string().regex(TIME_PATTERN, "use HH:mm (24-hour)");
const date = z.string().regex(DATE_PATTERN, "use YYYY-MM-DD");
const poisha = z.number().int().min(0).max(100_000_000);

const session = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: time,
  endTime: time,
  slotMinutes: z.number().int().min(5).max(120),
  maxPatients: z.number().int().min(1).max(200),
});
const leave = z
  .object({ from: date, to: date, reason: z.string().trim().max(120).optional() })
  .refine((l) => l.from <= l.to, { message: "leave must end on or after its start date", path: ["to"] });

const doctorBody = z.object({
  name: z.string().trim().min(2).max(100),
  nameBn: z.string().trim().max(100).optional(),
  title: z.string().trim().max(30).optional(),
  degrees: z.string().trim().max(200).optional(),
  specialization: z.string().trim().max(120).optional(),
  department: objectIdSchema,
  consultationFee: poisha,
  followUpFee: poisha,
  followUpValidDays: z.number().int().min(0).max(365).optional(),
  maxPatientsPerSession: z.number().int().min(1).max(200).optional(),
  averageMinutesPerPatient: z.number().int().min(1).max(120).optional(),
  roomNo: z.string().trim().max(20).optional(),
  photoUrl: z.string().trim().url().or(z.literal("")).optional(),
  bio: z.string().trim().max(1000).optional(),
  languages: z.array(z.string().trim().min(2).max(30)).max(6).optional(),
  sessions: z.array(session).max(40).default([]),
  leaves: z.array(leave).max(100).default([]),
});

const idParams = z.object({ id: objectIdSchema });
const listSchema = z.object({
  query: z.object({
    departmentId: objectIdSchema.optional(),
    search: z.string().trim().max(100).optional(),
    availableOn: date.optional(),
    status: z.enum(["active", "inactive"]).optional(),
    ...paginationQuery,
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
});
const createSchema = z.object({ body: doctorBody });
const updateSchema = z.object({ params: idParams, body: doctorBody.partial() });
const idSchema = z.object({ params: idParams });
const slotsSchema = z.object({ params: idParams, query: z.object({ date }) });
const calendarSchema = z.object({
  params: idParams,
  query: z.object({ days: z.coerce.number().int().min(1).max(60).default(14) }),
});
const linkSchema = z.object({ params: idParams, body: z.object({ userId: objectIdSchema.nullable() }) });

// ---------------------------------------------------------------- controller
// Admins also see which login account a doctor is linked to
const isAdmin = (req: Request) => roleHasPermission(req.user!.role, "master_data:manage");

const list = catchAsync(async (req: Request, res: Response) => {
  const { items, pagination } = await doctorService.listDoctors(req.query as never, { withAccount: isAdmin(req) });
  sendResponse(res, { statusCode: 200, success: true, message: "Doctors", data: items, pagination });
});
const get = catchAsync(async (req: Request, res: Response) => {
  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Doctor",
    data: await doctorService.getDoctor(req.params.id, { withAccount: isAdmin(req) }),
  });
});
const slots = catchAsync(async (req: Request, res: Response) => {
  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Slots",
    data: await getDoctorSlots(req.params.id, String(req.query.date)),
  });
});
const calendar = catchAsync(async (req: Request, res: Response) => {
  const data = await getAvailabilityCalendar(req.params.id, Number(req.query.days));
  sendResponse(res, { statusCode: 200, success: true, message: "Availability", data });
});
const create = catchAsync(async (req: Request, res: Response) => {
  sendResponse(res, {
    statusCode: 201,
    success: true,
    message: "Doctor created",
    data: await doctorService.createDoctor(req, req.body),
  });
});
const update = catchAsync(async (req: Request, res: Response) => {
  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Doctor updated",
    data: await doctorService.updateDoctor(req, req.params.id, req.body),
  });
});
const setActive = (active: boolean) =>
  catchAsync(async (req: Request, res: Response) => {
    const data = await doctorService.setDoctorActive(req, req.params.id, active);
    sendResponse(res, {
      statusCode: 200,
      success: true,
      message: active ? "Doctor activated" : "Doctor deactivated",
      data,
    });
  });
const link = catchAsync(async (req: Request, res: Response) => {
  const data = await doctorService.linkDoctorAccount(req, req.params.id, req.body.userId);
  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: req.body.userId ? "Account linked" : "Account unlinked",
    data,
  });
});

// ---------------------------------------------------------------- routes
const canRead = requireAnyPermission(["doctor:read", "master_data:manage"]);
const canManage = requirePermission("master_data:manage");

const router = express.Router();
router.use(authenticate());
router.get("/", canRead, validateRequest(listSchema), list);
router.get("/:id", canRead, validateRequest(idSchema), get);
router.get("/:id/slots", canRead, validateRequest(slotsSchema), slots);
router.get("/:id/availability", canRead, validateRequest(calendarSchema), calendar);
router.post("/", canManage, validateRequest(createSchema), create);
router.patch("/:id", canManage, validateRequest(updateSchema), update);
router.patch("/:id/activate", canManage, validateRequest(idSchema), setActive(true));
router.patch("/:id/deactivate", canManage, validateRequest(idSchema), setActive(false));
router.put("/:id/account", canManage, validateRequest(linkSchema), link);

export const DoctorRoutes = router;
