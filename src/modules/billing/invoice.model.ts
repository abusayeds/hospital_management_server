import mongoose, { HydratedDocument, Schema, Types } from "mongoose";
import { basePlugin, IBaseFields, IBaseMethods } from "../../models/plugins/basePlugin";
import { DATE_PATTERN } from "../../utils/date";

/**
 * INVOICE — what a patient owes for one encounter (a visit, a lab order, a dispense) or for a
 * manual bill made at the counter. All money is integer POISHA. Prices are SNAPSHOTS taken when
 * the line is added, so a later fee change never alters an old bill.
 *
 * Totals are derived from the lines, discounts, payments and refunds (recalculate() in the
 * service) — never typed in by hand. Invoices are never hard-deleted: a mistaken one is VOIDED
 * with a reason (status "void", soft delete fields kept by basePlugin for the audit trail).
 */

export const INVOICE_STATUSES = ["draft", "issued", "partial", "paid", "refunded", "void"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
// "overdue" is not stored: it is issued/partial with dueDate in the past (computed on read)

export const LINE_SOURCES = ["consultation", "lab_test", "medicine", "procedure", "other"] as const;
export type LineSource = (typeof LINE_SOURCES)[number];

export const PAYMENT_METHODS = ["cash", "card", "bkash", "nagad"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const ORIGIN_TYPES = ["visit", "lab_order", "dispense", "manual"] as const;
export type OriginType = (typeof ORIGIN_TYPES)[number];

export type InvoiceLine = {
  lineId: string;
  source: LineSource;
  sourceId?: string | null; // appointment / lab test / medicine / service id
  description: string;
  quantity: number;
  unitPrice: number; // poisha, snapshot
  lineTotal: number; // poisha = quantity × unitPrice
};

export type Discount = { amount: number; reason: string; approvedBy: Types.ObjectId; at: Date };

export type Payment = {
  paymentId: string;
  at: Date;
  method: PaymentMethod;
  amount: number;
  reference?: string; // bKash/Nagad transaction id, card slip number
  receivedBy: Types.ObjectId;
  notes?: string;
};

export type Refund = { amount: number; method: PaymentMethod; reason: string; by: Types.ObjectId; at: Date };

export interface IInvoice extends IBaseFields {
  invoiceNo: string; // INV-000456
  patient: Types.ObjectId;
  department?: Types.ObjectId | null;
  doctor?: Types.ObjectId | null;
  date: string; // YYYY-MM-DD (Dhaka) — the service date
  dueDate: string;
  status: InvoiceStatus;
  origin: { type: OriginType; id?: string | null };
  // "visit:<id>" / "lab_order:<id>" / "dispense:<id>" — unique, so an event processed twice
  // can never bill the same encounter twice. Absent on manual invoices.
  originKey?: string;
  items: InvoiceLine[];
  subtotal: number;
  discounts: Discount[];
  discountTotal: number;
  taxTotal: number; // zero for now; kept so receipts and reports have the column
  total: number;
  payments: Payment[];
  refunds: Refund[];
  amountPaid: number; // payments − refunds
  amountDue: number; // total − amountPaid
  notes?: string;
  issuedAt?: Date | null;
  issuedBy?: Types.ObjectId | null; // null = issued automatically by the system
  voidReason?: string | null;
  lastModifiedAt: Date;
}

export type InvoiceDocument = HydratedDocument<IInvoice, IBaseMethods>;

const LineSchema = new Schema<InvoiceLine>(
  {
    lineId: { type: String, required: true },
    source: { type: String, enum: LINE_SOURCES, required: true },
    sourceId: { type: String, default: null },
    description: { type: String, required: true, trim: true, maxlength: 200 },
    quantity: { type: Number, required: true, min: 1, max: 1000 },
    unitPrice: { type: Number, required: true, min: 0 },
    lineTotal: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const DiscountSchema = new Schema<Discount>(
  {
    amount: { type: Number, required: true, min: 1 },
    reason: { type: String, required: true, trim: true, maxlength: 200 },
    approvedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    at: { type: Date, required: true },
  },
  { _id: false },
);

const PaymentSchema = new Schema<Payment>(
  {
    paymentId: { type: String, required: true },
    at: { type: Date, required: true },
    method: { type: String, enum: PAYMENT_METHODS, required: true },
    amount: { type: Number, required: true, min: 1 },
    reference: { type: String, trim: true, maxlength: 80 },
    receivedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    notes: { type: String, trim: true, maxlength: 200 },
  },
  { _id: false },
);

const RefundSchema = new Schema<Refund>(
  {
    amount: { type: Number, required: true, min: 1 },
    method: { type: String, enum: PAYMENT_METHODS, required: true },
    reason: { type: String, required: true, trim: true, maxlength: 200 },
    by: { type: Schema.Types.ObjectId, ref: "User", required: true },
    at: { type: Date, required: true },
  },
  { _id: false },
);

const InvoiceSchema = new Schema<IInvoice>(
  {
    invoiceNo: { type: String, required: true, unique: true, immutable: true },
    patient: { type: Schema.Types.ObjectId, ref: "Patient", required: true },
    department: { type: Schema.Types.ObjectId, ref: "Department", default: null },
    doctor: { type: Schema.Types.ObjectId, ref: "Doctor", default: null },
    date: { type: String, required: true, match: DATE_PATTERN },
    dueDate: { type: String, required: true, match: DATE_PATTERN },
    status: { type: String, enum: INVOICE_STATUSES, default: "draft" },
    origin: {
      type: { type: String, enum: ORIGIN_TYPES, required: true },
      id: { type: String, default: null },
    },
    originKey: { type: String },
    items: { type: [LineSchema], default: [] },
    subtotal: { type: Number, default: 0, min: 0 },
    discounts: { type: [DiscountSchema], default: [] },
    discountTotal: { type: Number, default: 0, min: 0 },
    taxTotal: { type: Number, default: 0, min: 0 },
    total: { type: Number, default: 0, min: 0 },
    payments: { type: [PaymentSchema], default: [] },
    refunds: { type: [RefundSchema], default: [] },
    amountPaid: { type: Number, default: 0 },
    amountDue: { type: Number, default: 0 },
    notes: { type: String, trim: true, maxlength: 500 },
    issuedAt: { type: Date, default: null },
    issuedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    voidReason: { type: String, default: null, maxlength: 200 },
    lastModifiedAt: { type: Date, default: () => new Date() },
  },
  // Two cashiers saving the same invoice at once: the second save fails instead of
  // silently overwriting the first payment (VersionError → 409 "refresh and retry")
  { optimisticConcurrency: true },
);

// One invoice per encounter, enforced by the database (idempotent event consumers)
InvoiceSchema.index({ originKey: 1 }, { unique: true, sparse: true });
InvoiceSchema.index({ patient: 1, date: -1 });
InvoiceSchema.index({ status: 1, dueDate: 1 });
InvoiceSchema.index({ doctor: 1, date: -1 });
InvoiceSchema.index({ date: -1, status: 1 });
// Daily collection: payments by day and method
InvoiceSchema.index({ "payments.at": -1 });

InvoiceSchema.plugin(basePlugin);

export const InvoiceModel =
  mongoose.models.Invoice ||
  mongoose.model<IInvoice, mongoose.Model<IInvoice, object, IBaseMethods>>("Invoice", InvoiceSchema);
