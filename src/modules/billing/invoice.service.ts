/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from "crypto";
import { Request } from "express";
import mongoose, { Types } from "mongoose";
import { roleHasPermission } from "../../config/permissions";
import AppError from "../../errors/AppError";
import { publish } from "../../events/bus";
import { buildPagination } from "../../interface/global.interface";
import { nextCode } from "../../models/counter.model";
import { emitToPermission } from "../../sockets";
import { addDays, DATE_PATTERN, todayInDhaka } from "../../utils/date";
import { escapeRegex } from "../../utils/escapeRegex";
import { formatTaka } from "../../utils/money";
import { recordAudit } from "../audit/audit.service";
import { LabOrderModel } from "../clinical/lab/labOrder.model";
import { AppointmentModel } from "../hospital/appointment/appointment.model";
import { LabTestModel, ServiceModel } from "../hospital/catalog/catalog.models";
import { PatientModel } from "../patients/patient.model";
import {
  InvoiceDocument,
  InvoiceLine,
  InvoiceModel,
  InvoiceStatus,
  LineSource,
  OriginType,
  PaymentMethod,
} from "./invoice.model";

/**
 * BILLING SERVICE — the one place invoices are created and changed. Used by the API (manual
 * bills, payments, discounts), by the event consumers (automatic bills when a visit closes or
 * a lab report is verified) and, later, by the pharmacy dispense flow.
 *
 * Rules:
 *  - money is integer poisha; totals are always recalculated from lines/discounts/payments;
 *  - lines can change only while the invoice is a DRAFT; issuing locks them;
 *  - a payment can never exceed what is due; a refund never exceeds what was paid;
 *  - discounts and refunds need bill:discount and a reason; everything is audited;
 *  - nothing is hard-deleted: void (with reason) instead.
 */

const DEFAULT_DUE_DAYS = 30;
export const SYSTEM_ACTOR = "system";

export type Actor = { req?: Request };
const actorId = (actor: Actor) => (actor.req?.user?.id ? new Types.ObjectId(actor.req.user.id) : null);
const requireActor = (actor: Actor) => {
  const id = actorId(actor);
  if (!id) throw new AppError(401, "Please sign in to continue.", "UNAUTHORIZED");
  return id;
};

// ------------------------------------------------------------------ totals & status

/** Derive every total from the parts, and the status from what is paid */
export const recalculate = (inv: InvoiceDocument) => {
  inv.subtotal = inv.items.reduce((s, l) => s + l.lineTotal, 0);
  inv.discountTotal = inv.discounts.reduce((s, d) => s + d.amount, 0);
  inv.total = Math.max(0, inv.subtotal - inv.discountTotal + (inv.taxTotal ?? 0));
  const paid = inv.payments.reduce((s, p) => s + p.amount, 0);
  const refunded = inv.refunds.reduce((s, r) => s + r.amount, 0);
  inv.amountPaid = paid - refunded;
  inv.amountDue = Math.max(0, inv.total - inv.amountPaid);
  if (inv.status === "draft" || inv.status === "void") return;
  if (refunded > 0 && inv.amountPaid <= 0) inv.status = "refunded";
  else if (inv.amountPaid >= inv.total) inv.status = "paid";
  else if (inv.amountPaid > 0) inv.status = "partial";
  else inv.status = "issued";
};

/** issued/partial with a past due date — computed, never stored, so it is always current */
export const isOverdue = (inv: { status: InvoiceStatus; dueDate: string }, today = todayInDhaka()) =>
  (inv.status === "issued" || inv.status === "partial") && inv.dueDate < today;

// ------------------------------------------------------------------ view

const POPULATE = [
  { path: "patient", select: "name nameBn patientCode phone" },
  { path: "doctor", select: "title name" },
  { path: "department", select: "name nameBn" },
];

export const toInvoiceView = (inv: any) => ({
  id: String(inv._id),
  invoiceNo: inv.invoiceNo,
  date: inv.date,
  dueDate: inv.dueDate,
  status: inv.status as InvoiceStatus,
  overdue: isOverdue(inv),
  origin: inv.origin,
  patient: inv.patient?._id
    ? { id: String(inv.patient._id), name: inv.patient.name, nameBn: inv.patient.nameBn, patientCode: inv.patient.patientCode, phone: inv.patient.phone }
    : { id: String(inv.patient) },
  doctor: inv.doctor?._id ? { id: String(inv.doctor._id), displayName: `${inv.doctor.title ?? ""} ${inv.doctor.name}`.trim() } : null,
  department: inv.department?._id ? { id: String(inv.department._id), name: inv.department.name, nameBn: inv.department.nameBn } : null,
  items: (inv.items ?? []) as InvoiceLine[],
  subtotal: inv.subtotal,
  discounts: (inv.discounts ?? []).map((d: any) => ({ amount: d.amount as number, reason: d.reason as string, at: d.at as Date })),
  discountTotal: inv.discountTotal,
  taxTotal: inv.taxTotal,
  total: inv.total,
  payments: (inv.payments ?? []).map((p: any) => ({
    paymentId: p.paymentId as string,
    at: p.at as Date,
    method: p.method as PaymentMethod,
    amount: p.amount as number,
    reference: p.reference as string | undefined,
    notes: p.notes as string | undefined,
  })),
  refunds: (inv.refunds ?? []).map((r: any) => ({ amount: r.amount as number, method: r.method as PaymentMethod, reason: r.reason as string, at: r.at as Date })),
  amountPaid: inv.amountPaid,
  amountDue: inv.amountDue,
  notes: inv.notes,
  issuedAt: inv.issuedAt,
  autoIssued: Boolean(inv.issuedAt && !inv.issuedBy),
  voidReason: inv.voidReason,
  createdAt: inv.createdAt,
});
export type InvoiceView = ReturnType<typeof toInvoiceView>;

export const loadInvoice = async (id: string) => {
  if (!Types.ObjectId.isValid(id)) throw new AppError(400, "Invalid invoice id.", "INVALID_ID");
  const inv = await InvoiceModel.findById(id);
  if (!inv) throw new AppError(404, "Invoice not found.");
  return inv as InvoiceDocument;
};

const view = async (inv: InvoiceDocument) => toInvoiceView(await inv.populate(POPULATE));

/** Concurrent edit of the same invoice (optimistic concurrency) → a clear 409 */
const save = async (inv: InvoiceDocument) => {
  inv.lastModifiedAt = new Date();
  try {
    await inv.save();
  } catch (err) {
    if (err instanceof mongoose.Error.VersionError) {
      throw new AppError(409, "This invoice was changed by someone else a moment ago. Refresh and try again.", "CONFLICT");
    }
    throw err;
  }
};

const notify = (inv: InvoiceDocument) =>
  emitToPermission("bill:read", "billing:updated", { invoiceId: String(inv._id), patientId: String(inv.patient), status: inv.status });

const snapshot = (inv: InvoiceDocument) => ({
  invoiceNo: inv.invoiceNo,
  status: inv.status,
  total: inv.total,
  amountPaid: inv.amountPaid,
  amountDue: inv.amountDue,
  lines: inv.items.length,
});

// ------------------------------------------------------------------ create

export type NewLine = { source: LineSource; sourceId?: string | null; description: string; quantity?: number; unitPrice: number };

const toLine = (l: NewLine): InvoiceLine => {
  const quantity = l.quantity ?? 1;
  if (!Number.isInteger(l.unitPrice) || l.unitPrice < 0) throw new AppError(400, "Prices must be whole poisha (no fractions).", "VALIDATION_ERROR");
  return { lineId: randomUUID().slice(0, 8), source: l.source, sourceId: l.sourceId ?? null, description: l.description.slice(0, 200), quantity, unitPrice: l.unitPrice, lineTotal: quantity * l.unitPrice };
};

type CreateOptions = {
  patientId: string;
  lines: NewLine[];
  origin: { type: OriginType; id?: string | null };
  doctorId?: string | null;
  departmentId?: string | null;
  date?: string;
  dueDate?: string;
  notes?: string;
  issue?: boolean; // issue immediately (automatic invoices)
};

/**
 * Create an invoice. For encounter invoices (visit / lab order / dispense) the database's unique
 * originKey makes this idempotent: a second call for the same encounter returns the existing one.
 */
export const createInvoice = async (opts: CreateOptions, actor: Actor = {}) => {
  if (!opts.lines.length) throw new AppError(400, "An invoice needs at least one line.", "VALIDATION_ERROR");
  if (!(await PatientModel.exists({ _id: opts.patientId }))) throw new AppError(404, "Patient not found.");
  const date = opts.date ?? todayInDhaka();
  const dueDate = opts.dueDate ?? addDays(date, DEFAULT_DUE_DAYS);
  if (!DATE_PATTERN.test(dueDate) || dueDate < date) throw new AppError(400, "The due date must be on or after the invoice date.", "VALIDATION_ERROR");

  const originKey = opts.origin.type === "manual" ? undefined : `${opts.origin.type}:${opts.origin.id}`;
  if (originKey) {
    const existing = await InvoiceModel.findOne({ originKey });
    if (existing) return { invoice: existing as InvoiceDocument, created: false };
  }

  const by = actorId(actor);
  const inv = new InvoiceModel({
    invoiceNo: await nextCode("invoice", "INV"),
    patient: opts.patientId,
    doctor: opts.doctorId ?? null,
    department: opts.departmentId ?? null,
    date,
    dueDate,
    status: "draft",
    origin: { type: opts.origin.type, id: opts.origin.id ?? null },
    originKey,
    items: opts.lines.map(toLine),
    notes: opts.notes,
    createdBy: by,
  }) as InvoiceDocument;
  if (opts.issue) {
    inv.status = "issued";
    inv.issuedAt = new Date();
    inv.issuedBy = by; // null = the system issued it
  }
  recalculate(inv);
  try {
    await inv.save();
  } catch (err: any) {
    // Two events for the same encounter at once: the unique originKey kept one — return it
    if (err?.code === 11000 && originKey) return { invoice: (await InvoiceModel.findOne({ originKey })) as InvoiceDocument, created: false };
    throw err;
  }

  await recordAudit({ req: actor.req, action: "CREATE", entityType: "Invoice", entityId: inv._id, after: snapshot(inv), meta: { origin: opts.origin.type, system: !by } });
  if (inv.status === "issued") void publish("invoice.issued", { invoiceId: String(inv._id), patientId: String(inv.patient), total: inv.total });
  notify(inv);
  return { invoice: inv, created: true };
};

// ------------------------------------------------------------------ automatic invoices (event consumers call these)

/** Consultation fee of a closed visit (fee = the appointment's snapshot: new or follow-up) */
export const invoiceForVisit = async (p: { visitId: string; appointmentId: string; patientId: string; doctorId: string; date: string }) => {
  const appt = await AppointmentModel.findById(p.appointmentId).populate("doctor", "title name").lean<any>();
  if (!appt) throw new Error(`Appointment ${p.appointmentId} not found for visit ${p.visitId}`);
  const doctorName = `${appt.doctor?.title ?? ""} ${appt.doctor?.name ?? ""}`.trim();
  const lines: NewLine[] = appt.feeSnapshot > 0
    ? [{ source: "consultation", sourceId: String(appt._id), description: `Consultation${appt.type === "follow_up" ? " (follow-up)" : ""} — ${doctorName}`, unitPrice: appt.feeSnapshot }]
    : [];
  if (!lines.length) return null; // free consultation: nothing to bill
  const { invoice } = await createInvoice({
    patientId: p.patientId,
    doctorId: p.doctorId,
    departmentId: String(appt.department),
    date: p.date,
    origin: { type: "visit", id: p.visitId },
    lines,
    issue: true,
  });
  return invoice;
};

/** Test prices of a verified lab order (prices = the order's catalogue snapshot) */
export const invoiceForLabOrder = async (p: { labOrderId: string }) => {
  const order = await LabOrderModel.findById(p.labOrderId).lean<any>();
  if (!order) throw new Error(`Lab order ${p.labOrderId} not found`);
  const lines: NewLine[] = (order.tests ?? [])
    .filter((t: any) => t.price > 0)
    .map((t: any) => ({ source: "lab_test" as const, sourceId: String(t.labTest), description: `${t.name} (${t.code}) — ${order.orderNo}`, unitPrice: t.price }));
  if (!lines.length) return null;
  const { invoice } = await createInvoice({
    patientId: String(order.patient),
    doctorId: order.doctor ? String(order.doctor) : null,
    date: (order.verifiedAt ? new Date(order.verifiedAt) : new Date()).toLocaleDateString("en-CA", { timeZone: "Asia/Dhaka" }),
    origin: { type: "lab_order", id: String(order._id) },
    lines,
    issue: true,
  });
  return invoice;
};

/**
 * Medicines handed over by the pharmacy. The dispense flow (pharmacy module) calls this with
 * the dispensed lines; it is ready now so billing does not change when pharmacy arrives.
 */
export const invoiceForDispense = async (p: { dispenseId: string; patientId: string; lines: { medicineId: string; description: string; quantity: number; unitPrice: number }[] }, actor: Actor = {}) => {
  const { invoice } = await createInvoice(
    {
      patientId: p.patientId,
      origin: { type: "dispense", id: p.dispenseId },
      lines: p.lines.map((l) => ({ source: "medicine" as const, sourceId: l.medicineId, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice })),
      issue: true,
    },
    actor,
  );
  return invoice;
};

// ------------------------------------------------------------------ manual invoice (counter)

export type ManualItem =
  | { kind: "service"; serviceId: string; quantity?: number }
  | { kind: "lab_test"; labTestId: string; quantity?: number }
  | { kind: "consultation"; appointmentId: string }
  | { kind: "custom"; description: string; unitPrice: number; quantity?: number };

/** Resolve counter items against the catalogues (price snapshots) and refuse double billing */
const resolveManualItems = async (patientId: string, items: ManualItem[], req?: Request) => {
  const lines: NewLine[] = [];
  for (const item of items) {
    if (item.kind === "service") {
      const s = await ServiceModel.findOne({ _id: item.serviceId, isActive: true }).lean<any>();
      if (!s) throw new AppError(400, "A service on this bill was not found or is inactive.", "VALIDATION_ERROR");
      lines.push({ source: s.category === "consultation" ? "consultation" : "procedure", sourceId: String(s._id), description: s.name, quantity: item.quantity, unitPrice: s.price });
    } else if (item.kind === "lab_test") {
      const t = await LabTestModel.findOne({ _id: item.labTestId, isActive: true }).lean<any>();
      if (!t) throw new AppError(400, "A lab test on this bill was not found or is inactive.", "VALIDATION_ERROR");
      lines.push({ source: "lab_test", sourceId: String(t._id), description: `${t.name} (${t.code})`, quantity: item.quantity, unitPrice: t.price });
    } else if (item.kind === "consultation") {
      const a = await AppointmentModel.findById(item.appointmentId).populate("doctor", "title name").lean<any>();
      if (!a || String(a.patient) !== patientId) throw new AppError(400, "That appointment does not belong to this patient.", "VALIDATION_ERROR");
      // Already billed (automatically at visit close, or on another manual bill)?
      const billed = await InvoiceModel.exists({ status: { $ne: "void" }, items: { $elemMatch: { source: "consultation", sourceId: String(a._id) } } });
      if (billed) throw new AppError(409, "This consultation is already on another invoice.", "CONFLICT");
      lines.push({ source: "consultation", sourceId: String(a._id), description: `Consultation — ${`${a.doctor?.title ?? ""} ${a.doctor?.name ?? ""}`.trim()}`, unitPrice: a.feeSnapshot });
    } else {
      // Free-text prices bypass the catalogue: only staff who may give discounts can use them
      if (!req?.user || !roleHasPermission(req.user.role, "bill:discount")) throw new AppError(403, "Only accounts staff can add a custom-priced line.", "FORBIDDEN");
      lines.push({ source: "other", description: item.description, quantity: item.quantity, unitPrice: item.unitPrice });
    }
  }
  return lines;
};

export const createManualInvoice = async (req: Request, input: { patientId: string; items: ManualItem[]; dueDate?: string; notes?: string; issue?: boolean }) => {
  const lines = await resolveManualItems(input.patientId, input.items, req);
  const { invoice } = await createInvoice({ patientId: input.patientId, lines, origin: { type: "manual" }, dueDate: input.dueDate, notes: input.notes, issue: input.issue }, { req });
  return view(invoice);
};

/** Replace the lines of a DRAFT invoice (locked once issued) */
export const updateDraftItems = async (req: Request, id: string, items: ManualItem[]) => {
  const inv = await loadInvoice(id);
  if (inv.status !== "draft") throw new AppError(409, "Only a draft invoice can be edited. Issued invoices are locked.", "CONFLICT");
  const before = snapshot(inv);
  inv.items = (await resolveManualItems(String(inv.patient), items, req)).map(toLine);
  if (!inv.items.length) throw new AppError(400, "An invoice needs at least one line.", "VALIDATION_ERROR");
  inv.updatedBy = requireActor({ req });
  recalculate(inv);
  await save(inv);
  await recordAudit({ req, action: "UPDATE", entityType: "Invoice", entityId: inv._id, before, after: snapshot(inv) });
  notify(inv);
  return view(inv);
};

// ------------------------------------------------------------------ lifecycle

export const issueInvoice = async (req: Request, id: string) => {
  const inv = await loadInvoice(id);
  if (inv.status !== "draft") throw new AppError(409, `This invoice is already ${inv.status}.`, "CONFLICT");
  inv.status = "issued";
  inv.issuedAt = new Date();
  inv.issuedBy = requireActor({ req });
  recalculate(inv);
  await save(inv);
  await recordAudit({ req, action: "UPDATE", entityType: "Invoice", entityId: inv._id, before: { status: "draft" }, after: snapshot(inv), meta: { event: "issued" } });
  void publish("invoice.issued", { invoiceId: String(inv._id), patientId: String(inv.patient), total: inv.total });
  notify(inv);
  return view(inv);
};

export const addPayment = async (
  id: string,
  input: { amount: number; method: PaymentMethod; reference?: string; notes?: string },
  actor: Actor,
) => {
  const receivedBy = requireActor(actor);
  const inv = await loadInvoice(id);
  if (inv.status === "void" || inv.status === "refunded") throw new AppError(409, `A ${inv.status} invoice cannot take payments.`, "CONFLICT");
  if (!Number.isInteger(input.amount) || input.amount <= 0) throw new AppError(400, "Enter an amount above zero.", "VALIDATION_ERROR");
  if (input.amount > inv.amountDue) {
    throw new AppError(409, `Only ${formatTaka(inv.amountDue)} is due on this invoice.`, "CONFLICT", { amountDue: inv.amountDue });
  }
  if ((input.method === "bkash" || input.method === "nagad") && !input.reference) {
    throw new AppError(400, "Enter the bKash/Nagad transaction ID.", "VALIDATION_ERROR", [{ path: "body.reference", message: "required for mobile banking" }]);
  }
  const before = snapshot(inv);
  // Taking money for a draft means the bill is final: issue it first
  if (inv.status === "draft") {
    inv.status = "issued";
    inv.issuedAt = new Date();
    inv.issuedBy = receivedBy;
  }
  const paymentId = randomUUID().slice(0, 12);
  inv.payments.push({ paymentId, at: new Date(), method: input.method, amount: input.amount, reference: input.reference, receivedBy, notes: input.notes });
  inv.updatedBy = receivedBy;
  recalculate(inv);
  await save(inv);

  await recordAudit({ req: actor.req, action: "UPDATE", entityType: "Invoice", entityId: inv._id, before, after: snapshot(inv), meta: { event: "payment", method: input.method, amount: input.amount } });
  void publish("payment.collected", { invoiceId: String(inv._id), patientId: String(inv.patient), paymentId, amount: input.amount, method: input.method });
  notify(inv);
  return view(inv);
};

export const addDiscount = async (req: Request, id: string, input: { amount: number; reason: string }) => {
  const approvedBy = requireActor({ req });
  const inv = await loadInvoice(id);
  if (!["draft", "issued", "partial"].includes(inv.status)) throw new AppError(409, `A ${inv.status} invoice cannot be discounted.`, "CONFLICT");
  if (!Number.isInteger(input.amount) || input.amount <= 0) throw new AppError(400, "Enter a discount above zero.", "VALIDATION_ERROR");
  if (input.amount > inv.amountDue) throw new AppError(409, `The discount cannot be more than the amount due (${formatTaka(inv.amountDue)}).`, "CONFLICT");
  const before = snapshot(inv);
  inv.discounts.push({ amount: input.amount, reason: input.reason, approvedBy, at: new Date() });
  inv.updatedBy = approvedBy;
  recalculate(inv);
  await save(inv);
  await recordAudit({ req, action: "UPDATE", entityType: "Invoice", entityId: inv._id, before, after: snapshot(inv), meta: { event: "discount", amount: input.amount, reason: input.reason } });
  notify(inv);
  return view(inv);
};

/** Give money back (wrong charge, cancelled test). Never more than was paid. */
export const refundInvoice = async (req: Request, id: string, input: { amount: number; method: PaymentMethod; reason: string }) => {
  const by = requireActor({ req });
  const inv = await loadInvoice(id);
  if (!Number.isInteger(input.amount) || input.amount <= 0) throw new AppError(400, "Enter a refund above zero.", "VALIDATION_ERROR");
  if (input.amount > inv.amountPaid) throw new AppError(409, `Only ${formatTaka(inv.amountPaid)} was paid on this invoice.`, "CONFLICT");
  const before = snapshot(inv);
  inv.refunds.push({ amount: input.amount, method: input.method, reason: input.reason, by, at: new Date() });
  inv.updatedBy = by;
  recalculate(inv);
  await save(inv);
  await recordAudit({ req, action: "UPDATE", entityType: "Invoice", entityId: inv._id, before, after: snapshot(inv), meta: { event: "refund", amount: input.amount, reason: input.reason } });
  void publish("invoice.refunded", { invoiceId: String(inv._id), patientId: String(inv.patient), amount: input.amount });
  notify(inv);
  return view(inv);
};

/**
 * Write-off / void: the bill is cancelled but kept for the record (soft delete with reason).
 * Not possible while money is held — refund first.
 */
export const voidInvoice = async (req: Request, id: string, reason: string) => {
  const by = requireActor({ req });
  const inv = await loadInvoice(id);
  if (inv.status === "void") throw new AppError(409, "This invoice is already void.", "CONFLICT");
  if (inv.amountPaid > 0) throw new AppError(409, "Refund the payments before voiding this invoice.", "CONFLICT");
  const before = snapshot(inv);
  inv.status = "void";
  inv.voidReason = reason;
  inv.amountDue = 0;
  inv.updatedBy = by;
  inv.isDeleted = true;
  inv.deletedAt = new Date();
  inv.deletedBy = by;
  // The encounter may be billed again correctly after a void
  inv.originKey = undefined;
  await save(inv);
  await recordAudit({ req, action: "DELETE", entityType: "Invoice", entityId: inv._id, before, after: { status: "void", reason }, meta: { event: "void", soft: true } });
  notify(inv);
  return toInvoiceView(await InvoiceModel.findById(inv._id).setOptions({ withDeleted: true }).populate(POPULATE));
};

// ------------------------------------------------------------------ queries

export type ListFilters = {
  status?: InvoiceStatus | "overdue";
  from?: string;
  to?: string;
  patientId?: string;
  doctorId?: string;
  departmentId?: string;
  method?: PaymentMethod;
  q?: string;
  page: number;
  limit: number;
};

export const listInvoices = async (f: ListFilters) => {
  const filter: Record<string, unknown> = {};
  const today = todayInDhaka();
  if (f.status === "overdue") Object.assign(filter, { status: { $in: ["issued", "partial"] }, dueDate: { $lt: today } });
  else if (f.status) filter.status = f.status;
  if (f.from || f.to) filter.date = { ...(f.from && { $gte: f.from }), ...(f.to && { $lte: f.to }) };
  if (f.patientId) filter.patient = f.patientId;
  if (f.doctorId) filter.doctor = f.doctorId;
  if (f.departmentId) filter.department = f.departmentId;
  if (f.method) filter["payments.method"] = f.method;
  if (f.q) {
    const rx = new RegExp(escapeRegex(f.q), "i");
    const patients = await PatientModel.find({ $or: [{ name: rx }, { patientCode: rx }, { phone: rx }] }).limit(200).distinct("_id");
    filter.$or = [{ invoiceNo: rx }, { patient: { $in: patients } }];
  }
  const withVoid = f.status === "void";
  const query = InvoiceModel.find(filter).sort({ date: -1, createdAt: -1 }).skip((f.page - 1) * f.limit).limit(f.limit).populate(POPULATE);
  const count = InvoiceModel.countDocuments(filter);
  if (withVoid) {
    query.setOptions({ withDeleted: true });
    count.setOptions({ withDeleted: true });
  }
  const [items, total] = await Promise.all([query, count]);
  return { items: items.map(toInvoiceView), pagination: buildPagination(f.page, f.limit, total) };
};

export const getInvoice = async (id: string) => view(await loadInvoice(id));

/** Money taken on one day, by method and by department (refunds subtracted on the day they happen) */
export const dailyCollection = async (date = todayInDhaka()) => {
  const start = new Date(`${date}T00:00:00+06:00`);
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  const [payments, refunds] = await Promise.all([
    InvoiceModel.aggregate([
      { $unwind: "$payments" },
      { $match: { "payments.at": { $gte: start, $lt: end } } },
      { $lookup: { from: "departments", localField: "department", foreignField: "_id", as: "dept" } },
      {
        $group: {
          _id: { method: "$payments.method", department: { $ifNull: [{ $first: "$dept.name" }, "Other / counter"] } },
          amount: { $sum: "$payments.amount" },
          count: { $sum: 1 },
        },
      },
    ]),
    InvoiceModel.aggregate([
      { $unwind: "$refunds" },
      { $match: { "refunds.at": { $gte: start, $lt: end } } },
      { $group: { _id: "$refunds.method", amount: { $sum: "$refunds.amount" }, count: { $sum: 1 } } },
    ]),
  ]);
  const byMethod: Record<string, { amount: number; count: number }> = { cash: { amount: 0, count: 0 }, card: { amount: 0, count: 0 }, bkash: { amount: 0, count: 0 }, nagad: { amount: 0, count: 0 } };
  const byDepartment: Record<string, number> = {};
  for (const r of payments) {
    byMethod[r._id.method].amount += r.amount;
    byMethod[r._id.method].count += r.count;
    byDepartment[r._id.department] = (byDepartment[r._id.department] ?? 0) + r.amount;
  }
  const refundTotal = refunds.reduce((s, r) => s + r.amount, 0);
  for (const r of refunds) byMethod[r._id].amount -= r.amount;
  const gross = payments.reduce((s, r) => s + r.amount, 0);
  return {
    date,
    gross,
    refunds: refundTotal,
    net: gross - refundTotal,
    transactions: payments.reduce((s, r) => s + r.count, 0),
    byMethod,
    byDepartment: Object.entries(byDepartment)
      .map(([department, amount]) => ({ department, amount }))
      .sort((a, b) => b.amount - a.amount),
  };
};

export const billingService = {
  createInvoice,
  createManualInvoice,
  updateDraftItems,
  issueInvoice,
  addPayment,
  addDiscount,
  refundInvoice,
  voidInvoice,
  listInvoices,
  getInvoice,
  dailyCollection,
  invoiceForVisit,
  invoiceForLabOrder,
  invoiceForDispense,
};
