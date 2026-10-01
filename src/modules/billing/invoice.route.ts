import express, { Request, Response } from "express";
import { z } from "zod";
import { authenticate } from "../../middlewares/authenticate";
import { requireAnyPermission, requirePermission } from "../../middlewares/authorize";
import validateRequest, { objectIdSchema } from "../../middlewares/validateRequest";
import catchAsync from "../../utils/catchAsync";
import { maskTail } from "../../utils/crypto";
import { DATE_PATTERN } from "../../utils/date";
import sendResponse from "../../utils/sendResponse";
import { paginationQuery } from "../../validators/common";
import "./billing.consumers";
import { INVOICE_STATUSES, PAYMENT_METHODS } from "./invoice.model";
import { billingService, ListFilters, ManualItem } from "./invoice.service";
import { receiptPdf } from "./receipt.pdf";

// ---------------------------------------------------------------- validation
const date = z.string().regex(DATE_PATTERN, "use YYYY-MM-DD");
const poisha = z.number().int("whole poisha only").min(1).max(100_000_000);
const reason = z.string().trim().min(3, "Give a short reason").max(200);
const idParams = z.object({ id: objectIdSchema });

const manualItem = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("service"),
    serviceId: objectIdSchema,
    quantity: z.number().int().min(1).max(100).optional(),
  }),
  z.object({
    kind: z.literal("lab_test"),
    labTestId: objectIdSchema,
    quantity: z.number().int().min(1).max(20).optional(),
  }),
  z.object({ kind: z.literal("consultation"), appointmentId: objectIdSchema }),
  z.object({
    kind: z.literal("custom"),
    description: z.string().trim().min(2).max(200),
    unitPrice: poisha,
    quantity: z.number().int().min(1).max(100).optional(),
  }),
]);

const createSchema = z.object({
  body: z.object({
    patientId: objectIdSchema,
    items: z.array(manualItem).min(1).max(40),
    dueDate: date.optional(),
    notes: z.string().trim().max(500).optional(),
    issue: z.boolean().optional(),
  }),
});
const listSchema = z.object({
  query: z.object({
    status: z.enum([...INVOICE_STATUSES, "overdue"]).optional(),
    from: date.optional(),
    to: date.optional(),
    patientId: objectIdSchema.optional(),
    doctorId: objectIdSchema.optional(),
    departmentId: objectIdSchema.optional(),
    method: z.enum(PAYMENT_METHODS).optional(),
    q: z.string().trim().max(100).optional(),
    ...paginationQuery,
  }),
});
const idSchema = z.object({ params: idParams });
const itemsSchema = z.object({ params: idParams, body: z.object({ items: z.array(manualItem).min(1).max(40) }) });
const paymentSchema = z.object({
  params: idParams,
  body: z.object({
    amount: poisha,
    method: z.enum(PAYMENT_METHODS),
    reference: z.string().trim().max(80).optional(),
    notes: z.string().trim().max(200).optional(),
  }),
});
const discountSchema = z.object({ params: idParams, body: z.object({ amount: poisha, reason }) });
const refundSchema = z.object({
  params: idParams,
  body: z.object({ amount: poisha, method: z.enum(PAYMENT_METHODS), reason }),
});
const voidSchema = z.object({ params: idParams, body: z.object({ reason }) });
const collectionSchema = z.object({ query: z.object({ date: date.optional() }) });

// ---------------------------------------------------------------- controller
/**
 * Per-permission view: the cash counter (bill:collect) needs the patient's phone to reach them about
 * dues; read-only finance viewers (management) see it masked.
 */
type InvoiceLike = { patient?: { phone?: string | null } & Record<string, unknown> } & Record<string, unknown>;
const forViewer = <T extends InvoiceLike>(req: Request, inv: T): T =>
  req.user?.permissions.includes("bill:collect") || !inv.patient?.phone
    ? inv
    : { ...inv, patient: { ...inv.patient, phone: maskTail(inv.patient.phone, 3) } };
const ok = (res: Response, message: string, data: unknown, statusCode = 200) =>
  sendResponse(res, { statusCode, success: true, message, data });

const list = catchAsync(async (req: Request, res: Response) => {
  const { items, pagination } = await billingService.listInvoices(req.query as unknown as ListFilters);
  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Invoices",
    data: items.map((i) => forViewer(req, i)),
    pagination,
  });
});
const get = catchAsync(async (req: Request, res: Response) =>
  ok(res, "Invoice", forViewer(req, await billingService.getInvoice(req.params.id))),
);
const create = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Invoice created",
    await billingService.createManualInvoice(req, { ...req.body, items: req.body.items as ManualItem[] }),
    201,
  ),
);
const updateItems = catchAsync(async (req: Request, res: Response) =>
  ok(res, "Invoice updated", await billingService.updateDraftItems(req, req.params.id, req.body.items)),
);
const issue = catchAsync(async (req: Request, res: Response) =>
  ok(res, "Invoice issued", await billingService.issueInvoice(req, req.params.id)),
);
const pay = catchAsync(async (req: Request, res: Response) =>
  ok(res, "Payment recorded", await billingService.addPayment(req.params.id, req.body, { req })),
);
const discount = catchAsync(async (req: Request, res: Response) =>
  ok(res, "Discount added", await billingService.addDiscount(req, req.params.id, req.body)),
);
const refund = catchAsync(async (req: Request, res: Response) =>
  ok(res, "Refund recorded", await billingService.refundInvoice(req, req.params.id, req.body)),
);
const voidIt = catchAsync(async (req: Request, res: Response) =>
  ok(res, "Invoice voided", await billingService.voidInvoice(req, req.params.id, req.body.reason)),
);
const receipt = catchAsync(async (req: Request, res: Response) => {
  const { pdf, fileName } = await receiptPdf(req, req.params.id);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
  res.setHeader("Cache-Control", "no-store");
  res.send(pdf);
});
const collection = catchAsync(async (req: Request, res: Response) =>
  ok(res, "Daily collection", await billingService.dailyCollection(req.query.date as string | undefined)),
);

// ---------------------------------------------------------------- routes
const router = express.Router();
router.use(authenticate());
router.get("/", requirePermission("bill:read"), validateRequest(listSchema), list);
router.post("/", requirePermission("bill:collect"), validateRequest(createSchema), create);
router.get("/:id", requirePermission("bill:read"), validateRequest(idSchema), get);
router.get("/:id/receipt.pdf", requirePermission("bill:read"), validateRequest(idSchema), receipt);
router.put("/:id/items", requirePermission("bill:collect"), validateRequest(itemsSchema), updateItems);
router.post("/:id/issue", requirePermission("bill:collect"), validateRequest(idSchema), issue);
router.post("/:id/payment", requirePermission("bill:collect"), validateRequest(paymentSchema), pay);
router.post("/:id/discount", requirePermission("bill:discount"), validateRequest(discountSchema), discount);
router.post("/:id/refund", requirePermission("bill:discount"), validateRequest(refundSchema), refund);
router.post("/:id/void", requirePermission("bill:discount"), validateRequest(voidSchema), voidIt);
export const InvoiceRoutes = router;

// /reports/daily-collection — finance staff and the cash counter
export const FinanceReportRoutes = express.Router();
FinanceReportRoutes.get(
  "/daily-collection",
  authenticate(),
  requireAnyPermission(["report:finance", "bill:collect"]),
  validateRequest(collectionSchema),
  collection,
);
