import express, { Request, Response } from "express";
import { z } from "zod";
import { authenticate } from "../../middlewares/authenticate";
import { requirePermission } from "../../middlewares/authorize";
import { loginLimiter } from "../../middlewares/rateLimiter";
import validateRequest, { objectIdSchema } from "../../middlewares/validateRequest";
import { setAuthCookies } from "../auth/tokens";
import catchAsync from "../../utils/catchAsync";
import { DATE_PATTERN, TIME_PATTERN } from "../../utils/date";
import sendResponse from "../../utils/sendResponse";
import { receiptPdf } from "../billing/receipt.pdf";
import { labReportPdf } from "../clinical/lab/lab.pdf";
import { prescriptionPdf } from "../clinical/visits/prescription.pdf";
import * as portal from "./portal.service";

const phone = z.string().trim().min(10).max(20);
const date = z.string().regex(DATE_PATTERN, "use YYYY-MM-DD");
const idParams = z.object({ params: z.object({ id: objectIdSchema }) });

const ok = (res: Response, message: string, data: unknown, statusCode = 200) =>
  sendResponse(res, { statusCode, success: true, message, data });
const sendPdf = (res: Response, out: { pdf: Buffer | Uint8Array; fileName: string }) => {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${out.fileName}"`);
  res.setHeader("Cache-Control", "no-store");
  res.send(Buffer.from(out.pdf));
};

// ---------------------------------------------------------------- sign-in (public)
export const PortalAuthRoutes = express.Router();
PortalAuthRoutes.post(
  "/request-code",
  loginLimiter,
  validateRequest(z.object({ body: z.object({ phone }) })),
  catchAsync(async (req, res) => ok(res, "Code sent", await portal.requestCode(req.body.phone))),
);
PortalAuthRoutes.post(
  "/verify",
  loginLimiter,
  validateRequest(
    z.object({
      body: z.object({
        phone,
        code: z
          .string()
          .trim()
          .regex(/^\d{6}$/, "Enter the 6-digit code"),
      }),
    }),
  ),
  catchAsync(async (req: Request, res: Response) => {
    const { user, accessToken, refreshToken } = await portal.verifyCode(req, req.body.phone, req.body.code);
    setAuthCookies(res, accessToken, refreshToken);
    ok(res, "Signed in", { user });
  }),
);

// ---------------------------------------------------------------- own records (patients only)
const router = express.Router();
router.use(authenticate(), requirePermission("portal:own_records"));

router.get(
  "/me",
  catchAsync(async (req, res) => ok(res, "Me", await portal.me(req))),
);
router.get(
  "/appointments",
  catchAsync(async (req, res) => ok(res, "Appointments", await portal.appointments(req))),
);
router.get(
  "/doctors",
  catchAsync(async (_req, res) => ok(res, "Doctors", await portal.doctors())),
);
router.get(
  "/doctors/:id/availability",
  validateRequest(idParams),
  catchAsync(async (req, res) => ok(res, "Availability", await portal.availability(req.params.id))),
);
router.get(
  "/doctors/:id/slots",
  validateRequest(z.object({ params: z.object({ id: objectIdSchema }), query: z.object({ date }) })),
  catchAsync(async (req, res) => ok(res, "Slots", await portal.slots(req.params.id, req.query.date as string))),
);
router.get(
  "/quote",
  validateRequest(z.object({ query: z.object({ patientId: objectIdSchema, doctorId: objectIdSchema, date }) })),
  catchAsync(async (req, res) =>
    ok(
      res,
      "Fee",
      await portal.quote(req, req.query.patientId as string, req.query.doctorId as string, req.query.date as string),
    ),
  ),
);
router.post(
  "/appointments",
  validateRequest(
    z.object({
      body: z.object({
        patientId: objectIdSchema,
        doctorId: objectIdSchema,
        date,
        slotTime: z.string().regex(TIME_PATTERN, "Use HH:mm"),
      }),
    }),
  ),
  catchAsync(async (req, res) => ok(res, "Appointment booked", await portal.book(req, req.body), 201)),
);
router.post(
  "/appointments/:id/cancel",
  validateRequest(
    z.object({
      params: z.object({ id: objectIdSchema }),
      body: z.object({ reason: z.string().trim().min(2, "Tell us why").max(200) }),
    }),
  ),
  catchAsync(async (req, res) =>
    ok(res, "Appointment cancelled", await portal.cancel(req, req.params.id, req.body.reason)),
  ),
);
router.get(
  "/prescriptions",
  catchAsync(async (req, res) => ok(res, "Prescriptions", await portal.prescriptions(req))),
);
router.get(
  "/prescriptions/:id/pdf",
  validateRequest(idParams),
  catchAsync(async (req, res) =>
    sendPdf(res, await prescriptionPdf(req, req.params.id, await portal.ownerCheckFor(req))),
  ),
);
router.get(
  "/reports",
  catchAsync(async (req, res) => ok(res, "Lab reports", await portal.reports(req))),
);
router.get(
  "/reports/:id/pdf",
  validateRequest(idParams),
  catchAsync(async (req, res) => sendPdf(res, await labReportPdf(req, req.params.id, await portal.ownerCheckFor(req)))),
);
router.get(
  "/bills",
  catchAsync(async (req, res) => ok(res, "Bills", await portal.bills(req))),
);
router.get(
  "/bills/:id/pdf",
  validateRequest(idParams),
  catchAsync(async (req, res) => {
    await portal.invoiceOwner(req, req.params.id);
    sendPdf(res, await receiptPdf(req, req.params.id));
  }),
);
export const PortalRoutes = router;
