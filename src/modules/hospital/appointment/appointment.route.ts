import express, { Request, Response } from "express";
import { z } from "zod";
import { roleHasPermission } from "../../../config/permissions";
import { authenticate } from "../../../middlewares/authenticate";
import { assertCanAccess, requireAnyPermission, requirePermission } from "../../../middlewares/authorize";
import validateRequest, { objectIdSchema } from "../../../middlewares/validateRequest";
import catchAsync from "../../../utils/catchAsync";
import { DATE_PATTERN, TIME_PATTERN } from "../../../utils/date";
import sendResponse from "../../../utils/sendResponse";
import { paginationQuery } from "../../../validators/common";
import { findDoctorForUser } from "../doctor/doctor.service";
import { APPOINTMENT_STATUSES, PRIORITIES } from "./appointment.model";
import { sendBackHandler } from "../queue/queue.route";
import { appointmentService, ListFilters } from "./appointment.service";

// ---------------------------------------------------------------- validation
const date = z.string().regex(DATE_PATTERN, "use YYYY-MM-DD");
const time = z.string().regex(TIME_PATTERN, "use HH:mm");
const idParams = z.object({ id: objectIdSchema });

const createSchema = z.object({
  body: z.object({
    patientId: objectIdSchema,
    doctorId: objectIdSchema,
    date,
    slotTime: time.optional(), // omitted → next available slot
    priority: z.enum(PRIORITIES).optional(),
    notes: z.string().trim().max(500).optional(),
    source: z.enum(["reception", "phone", "walk_in"]).default("reception"),
    checkInNow: z.boolean().optional(), // walk-in: book + check in in one click
  }),
});
const listSchema = z.object({
  query: z.object({
    date: date.optional(),
    doctorId: objectIdSchema.optional(),
    status: z.enum(APPOINTMENT_STATUSES).optional(),
    patientId: objectIdSchema.optional(),
    q: z.string().trim().max(100).optional(),
    ...paginationQuery,
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
});
const idSchema = z.object({ params: idParams });
const checkInSchema = z.object({ params: idParams, body: z.object({ priority: z.enum(PRIORITIES).optional() }).default({}) });
const cancelSchema = z.object({ params: idParams, body: z.object({ reason: z.string().trim().min(2, "Give a short reason").max(300) }) });
const rescheduleSchema = z.object({ params: idParams, body: z.object({ date, slotTime: time.optional(), doctorId: objectIdSchema.optional() }) });

// ---------------------------------------------------------------- object-level access
/**
 * Front desk and management see every doctor's appointments. A doctor (no
 * appointment:update_status, but queue:call_next) sees ONLY their own — enforced here
 * in the API, not just hidden in the UI. Returns undefined = no restriction.
 */
export const ownDoctorScope = async (req: Request): Promise<string | null | undefined> => {
  const role = req.user!.role;
  if (roleHasPermission(role, "appointment:update_status") || roleHasPermission(role, "report:operations")) return undefined;
  if (!roleHasPermission(role, "queue:call_next")) return undefined;
  const doctor = await findDoctorForUser(req.user!.id);
  return doctor ? String(doctor._id) : null;
};

// ---------------------------------------------------------------- controller
const actor = (req: Request) => ({ req });

const list = catchAsync(async (req: Request, res: Response) => {
  const restrictToDoctorId = await ownDoctorScope(req);
  const { items, pagination } = await appointmentService.listAppointments({ ...(req.query as unknown as ListFilters), restrictToDoctorId });
  sendResponse(res, { statusCode: 200, success: true, message: "Appointments", data: items, pagination });
});

const get = catchAsync(async (req: Request, res: Response) => {
  const appt = await appointmentService.getAppointment(req.params.id);
  const scope = await ownDoctorScope(req);
  if (scope !== undefined) await assertCanAccess(req, appt.doctor.id === scope, { entityType: "Appointment", entityId: appt.id });
  sendResponse(res, { statusCode: 200, success: true, message: "Appointment", data: appt });
});

const create = catchAsync(async (req: Request, res: Response) => {
  const { checkInNow, ...body } = req.body;
  const data = await appointmentService.bookAppointment({ ...body, checkInNow: checkInNow || body.source === "walk_in" }, actor(req));
  sendResponse(res, { statusCode: 201, success: true, message: `Booked · serial ${data.serialNo}`, data });
});

const checkIn = catchAsync(async (req: Request, res: Response) => {
  sendResponse(res, { statusCode: 200, success: true, message: "Checked in", data: await appointmentService.checkIn(req.params.id, actor(req), req.body.priority) });
});
const cancel = catchAsync(async (req: Request, res: Response) => {
  sendResponse(res, { statusCode: 200, success: true, message: "Cancelled", data: await appointmentService.cancelAppointment(req.params.id, req.body.reason, actor(req)) });
});
const noShow = catchAsync(async (req: Request, res: Response) => {
  sendResponse(res, { statusCode: 200, success: true, message: "Marked as no-show", data: await appointmentService.markNoShow(req.params.id, actor(req)) });
});
const reschedule = catchAsync(async (req: Request, res: Response) => {
  const data = await appointmentService.rescheduleAppointment(req.params.id, req.body, actor(req));
  sendResponse(res, { statusCode: 200, success: true, message: `Rescheduled · new serial ${data.serialNo}`, data });
});

// ---------------------------------------------------------------- routes
const router = express.Router();
router.use(authenticate());
router.get("/", requirePermission("appointment:read"), validateRequest(listSchema), list);
router.post("/", requirePermission("appointment:create"), validateRequest(createSchema), create);
router.get("/:id", requirePermission("appointment:read"), validateRequest(idSchema), get);
router.post("/:id/check-in", requirePermission("appointment:update_status"), validateRequest(checkInSchema), checkIn);
router.post("/:id/cancel", requirePermission("appointment:update_status"), validateRequest(cancelSchema), cancel);
router.post("/:id/no-show", requirePermission("appointment:update_status"), validateRequest(idSchema), noShow);
router.post("/:id/reschedule", requirePermission("appointment:update_status"), validateRequest(rescheduleSchema), reschedule);
// Patient stepped out of the consulting room → back to waiting (doctor for own queue, or front desk)
router.post("/:id/send-back", requireAnyPermission(["queue:call_next", "queue:manage"]), validateRequest(idSchema), sendBackHandler);

export const AppointmentRoutes = router;
