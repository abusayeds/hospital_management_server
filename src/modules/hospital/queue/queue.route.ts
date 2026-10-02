import express, { Request, Response } from "express";
import { z } from "zod";
import { roleHasPermission } from "../../../config/permissions";
import AppError from "../../../errors/AppError";
import { authenticate } from "../../../middlewares/authenticate";
import { assertCanAccess, requireAnyPermission, requirePermission } from "../../../middlewares/authorize";
import validateRequest, { objectIdSchema } from "../../../middlewares/validateRequest";
import catchAsync from "../../../utils/catchAsync";
import sendResponse from "../../../utils/sendResponse";
import { findDoctorForUser } from "../doctor/doctor.service";
import { getDisplayBoard } from "./display.service";
import { queueService } from "./queue.service";

// ---------------------------------------------------------------- object-level access

/** The doctor profile linked to the signed-in user, or null */
const myDoctorId = async (req: Request) => {
  const doctor = await findDoctorForUser(req.user!.id);
  return doctor ? String(doctor._id) : null;
};

/**
 * A doctor may only see and run THEIR OWN queue. Front-desk roles with `queue:manage`
 * may act on any doctor's queue where `allowFrontDesk` is set (recall, send back).
 * Viewers with queue:read who are not doctors (reception, nurse, management) may look.
 */
const assertQueueAccess = async (
  req: Request,
  doctorId: string,
  { act, allowFrontDesk = false }: { act: boolean; allowFrontDesk?: boolean },
) => {
  const role = req.user!.role;
  const isDoctor = roleHasPermission(role, "queue:call_next");
  if (!isDoctor) {
    if (!act) return; // viewing
    if (allowFrontDesk && roleHasPermission(role, "queue:manage")) return;
  }
  const mine = isDoctor ? await myDoctorId(req) : null;
  await assertCanAccess(req, mine === doctorId, { entityType: "Queue", entityId: doctorId });
};

// ---------------------------------------------------------------- validation
const doctorParams = z.object({ params: z.object({ doctorId: objectIdSchema }) });
const callSpecificSchema = z.object({ params: z.object({ doctorId: objectIdSchema, appointmentId: objectIdSchema }) });
const todaySchema = z.object({ query: z.object({ doctorId: objectIdSchema.optional() }) });

// ---------------------------------------------------------------- controller
const actor = (req: Request) => ({ req });

/** ?doctorId= → that doctor's full queue; no doctorId → a doctor gets their own queue, others the board */
const today = catchAsync(async (req: Request, res: Response) => {
  let doctorId = req.query.doctorId as string | undefined;
  if (!doctorId && roleHasPermission(req.user!.role, "queue:call_next")) {
    doctorId = (await myDoctorId(req)) ?? undefined;
    if (!doctorId) throw new AppError(404, "Your login is not linked to a doctor profile yet. Ask the administrator.");
  }
  if (!doctorId) {
    sendResponse(res, {
      statusCode: 200,
      success: true,
      message: "Today's board",
      data: await queueService.getTodayBoard(),
    });
    return;
  }
  await assertQueueAccess(req, doctorId, { act: false });
  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Queue",
    data: await queueService.getDoctorQueue(doctorId),
  });
});

const board = catchAsync(async (_req: Request, res: Response) => {
  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Today's board",
    data: await queueService.getTodayBoard(),
  });
});

const callNext = catchAsync(async (req: Request, res: Response) => {
  await assertQueueAccess(req, req.params.doctorId, { act: true });
  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Next patient called",
    data: await queueService.callNext(req.params.doctorId, actor(req)),
  });
});

const callSpecific = catchAsync(async (req: Request, res: Response) => {
  await assertQueueAccess(req, req.params.doctorId, { act: true });
  const data = await queueService.callSpecific(req.params.doctorId, req.params.appointmentId, actor(req));
  sendResponse(res, { statusCode: 200, success: true, message: "Patient called", data });
});

const recall = catchAsync(async (req: Request, res: Response) => {
  await assertQueueAccess(req, req.params.doctorId, { act: true, allowFrontDesk: true });
  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Announced again",
    data: await queueService.recall(req.params.doctorId, actor(req)),
  });
});

/** POST /appointments/:id/send-back — mounted on the appointments router */
export const sendBackHandler = catchAsync(async (req: Request, res: Response) => {
  const role = req.user!.role;
  const scope = roleHasPermission(role, "queue:manage") ? undefined : ((await myDoctorId(req)) ?? "none");
  const data = await queueService.sendBack(req.params.id, actor(req), scope);
  sendResponse(res, { statusCode: 200, success: true, message: "Sent back to waiting", data });
});

// ---------------------------------------------------------------- routes (staff)
const router = express.Router();
router.use(authenticate());
router.get("/today", requirePermission("queue:read"), validateRequest(todaySchema), today);
router.get("/board", requirePermission("queue:read"), board);
router.post("/:doctorId/call-next", requirePermission("queue:call_next"), validateRequest(doctorParams), callNext);
router.post(
  "/:doctorId/call/:appointmentId",
  requirePermission("queue:call_next"),
  validateRequest(callSpecificSchema),
  callSpecific,
);
router.post(
  "/:doctorId/recall",
  requireAnyPermission(["queue:call_next", "queue:manage"]),
  validateRequest(doctorParams),
  recall,
);
export const QueueRoutes = router;

// ---------------------------------------------------------------- routes (public queue board, no login)
export const DisplayRoutes = express.Router();
DisplayRoutes.get(
  "/queue",
  catchAsync(async (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    sendResponse(res, { statusCode: 200, success: true, message: "Display board", data: await getDisplayBoard() });
  }),
);
