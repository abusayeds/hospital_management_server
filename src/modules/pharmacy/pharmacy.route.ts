import express, { Request, Response } from "express";
import { z } from "zod";
import { authenticate } from "../../middlewares/authenticate";
import { requireAnyPermission, requirePermission } from "../../middlewares/authorize";
import validateRequest, { objectIdSchema } from "../../middlewares/validateRequest";
import catchAsync from "../../utils/catchAsync";
import { DATE_PATTERN } from "../../utils/date";
import sendResponse from "../../utils/sendResponse";
import { paginationQuery } from "../../validators/common";
import * as pharmacy from "./pharmacy.service";

// ---------------------------------------------------------------- validation
const date = z.string().regex(DATE_PATTERN, "use YYYY-MM-DD");
const poisha = z.number().int("whole poisha only").min(0).max(100_000_000);
const units = z.number().int("whole units only").min(1).max(100_000);
const idParams = z.object({ params: z.object({ id: objectIdSchema }) });
const reason = z.string().trim().min(3, "Give a short reason").max(200);

const queueSchema = z.object({
  query: z.object({
    status: z.enum(["pending", "dispensed", "all"]).default("pending"),
    q: z.string().trim().max(60).optional(),
    days: z.coerce.number().int().min(1).max(90).default(7),
  }),
});
const dispenseSchema = z.object({
  body: z.object({
    patientId: objectIdSchema,
    visitId: objectIdSchema.nullish(),
    items: z
      .array(
        z.object({
          medicineId: objectIdSchema,
          quantity: units,
          prescribedIndex: z.number().int().min(0).max(50).nullish(),
        }),
      )
      .min(1)
      .max(40),
    notes: z.string().trim().max(500).optional(),
  }),
});
const rangeSchema = z.object({
  query: z.object({
    from: date.optional(),
    to: date.optional(),
    q: z.string().trim().max(60).optional(),
    ...paginationQuery,
  }),
});
const stockSchema = z.object({
  query: z.object({
    q: z.string().trim().max(60).optional(),
    filter: z.enum(["all", "low", "out", "in_stock"]).default("all"),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
});
const reorderSchema = z.object({
  params: z.object({ id: objectIdSchema }),
  body: z.object({ reorderLevel: z.number().int().min(0).max(100_000) }),
});
const adjustSchema = z.object({
  params: z.object({ id: objectIdSchema }),
  body: z.object({
    change: z.number().int().min(-100_000).max(100_000).default(0),
    reason,
    writeOff: z.boolean().optional(),
  }),
});
const expirySchema = z.object({ query: z.object({ days: z.coerce.number().int().min(1).max(365).default(90) }) });
const purchaseSchema = z.object({
  body: z.object({
    supplier: z.string().trim().min(2, "Enter the supplier").max(120),
    supplierInvoiceNo: z.string().trim().max(60).optional(),
    date,
    notes: z.string().trim().max(500).optional(),
    items: z
      .array(
        z
          .object({
            medicineId: objectIdSchema,
            batchNo: z.string().trim().min(1, "Enter the batch no.").max(60),
            expiryDate: date,
            quantity: units,
            unitCost: poisha,
            unitPrice: poisha.refine((v) => v > 0, "Enter the selling price"),
          })
          .refine((i) => i.unitPrice >= i.unitCost, {
            message: "The selling price is below the cost",
            path: ["unitPrice"],
          }),
      )
      .min(1)
      .max(100),
  }),
});

// ---------------------------------------------------------------- controller
const ok = (res: Response, message: string, data: unknown, statusCode = 200) =>
  sendResponse(res, { statusCode, success: true, message, data });
const paged = (res: Response, message: string, r: { items: unknown[]; pagination: unknown }) =>
  sendResponse(res, { statusCode: 200, success: true, message, data: r.items, pagination: r.pagination as never });

const router = express.Router();
router.use(authenticate());

// Dashboard
router.get(
  "/summary",
  requireAnyPermission(["dispense:create", "stock:read"]),
  catchAsync(async (_req, res) => ok(res, "Pharmacy summary", await pharmacy.pharmacySummary())),
);

// Prescriptions → dispense
router.get(
  "/prescriptions",
  requirePermission("dispense:create"),
  validateRequest(queueSchema),
  catchAsync(async (req: Request, res: Response) =>
    ok(res, "Prescriptions", await pharmacy.prescriptionQueue(req.query as never)),
  ),
);
router.get(
  "/prescriptions/:id",
  requirePermission("dispense:create"),
  validateRequest(idParams),
  catchAsync(async (req, res) => ok(res, "Prescription", await pharmacy.prescriptionForDispense(req.params.id))),
);
router.post(
  "/dispenses",
  requirePermission("dispense:create"),
  validateRequest(dispenseSchema),
  catchAsync(async (req, res) => ok(res, "Medicines dispensed", await pharmacy.dispense(req, req.body), 201)),
);
router.get(
  "/dispenses",
  requirePermission("dispense:create"),
  validateRequest(rangeSchema),
  catchAsync(async (req, res) => paged(res, "Dispenses", await pharmacy.listDispenses(req.query as never))),
);
router.get(
  "/dispenses/:id",
  requirePermission("dispense:create"),
  validateRequest(idParams),
  catchAsync(async (req, res) => ok(res, "Dispense", await pharmacy.getDispense(req.params.id))),
);

// Stock
router.get(
  "/stock",
  requirePermission("stock:read"),
  validateRequest(stockSchema),
  catchAsync(async (req, res) => paged(res, "Stock", await pharmacy.stockList(req.query as never))),
);
router.get(
  "/stock/:id",
  requirePermission("stock:read"),
  validateRequest(idParams),
  catchAsync(async (req, res) => ok(res, "Medicine stock", await pharmacy.medicineStock(req.params.id))),
);
router.put(
  "/stock/:id/reorder-level",
  requirePermission("stock:manage"),
  validateRequest(reorderSchema),
  catchAsync(async (req, res) =>
    ok(res, "Reorder level saved", await pharmacy.setReorderLevel(req, req.params.id, req.body.reorderLevel)),
  ),
);
router.post(
  "/batches/:id/adjust",
  requirePermission("stock:manage"),
  validateRequest(adjustSchema),
  catchAsync(async (req, res) =>
    ok(
      res,
      req.body.writeOff ? "Batch written off" : "Stock adjusted",
      await pharmacy.adjustBatch(req, req.params.id, req.body),
    ),
  ),
);
router.get(
  "/expiry",
  requirePermission("stock:read"),
  validateRequest(expirySchema),
  catchAsync(async (req, res) => ok(res, "Expiry report", await pharmacy.expiryReport(Number(req.query.days)))),
);

// Purchases
router.get(
  "/purchases",
  requirePermission("stock:manage"),
  validateRequest(rangeSchema),
  catchAsync(async (req, res) => paged(res, "Purchases", await pharmacy.listPurchases(req.query as never))),
);
router.get(
  "/purchases/suppliers",
  requirePermission("stock:manage"),
  catchAsync(async (_req, res) => ok(res, "Suppliers", await pharmacy.suppliers())),
);
router.get(
  "/purchases/:id",
  requirePermission("stock:manage"),
  validateRequest(idParams),
  catchAsync(async (req, res) => ok(res, "Purchase", await pharmacy.getPurchase(req.params.id))),
);
router.post(
  "/purchases",
  requirePermission("stock:manage"),
  validateRequest(purchaseSchema),
  catchAsync(async (req, res) => ok(res, "Stock received", await pharmacy.createPurchase(req, req.body), 201)),
);

export const PharmacyRoutes = router;
