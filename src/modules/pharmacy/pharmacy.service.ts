/* eslint-disable @typescript-eslint/no-explicit-any */
import { Request } from "express";
import mongoose, { ClientSession, Types } from "mongoose";
import AppError from "../../errors/AppError";
import { publish } from "../../events/bus";
import { buildPagination } from "../../interface/global.interface";
import { nextCode } from "../../models/counter.model";
import { emitToPermission } from "../../sockets/index";
import { addDays, ageOn, todayInDhaka } from "../../utils/date";
import { logger } from "../../utils/logger";
import { recordAudit } from "../audit/audit.service";
import { sendToStaff } from "../automation/outbox/outbox.service";
import { VisitModel } from "../clinical/visits/visit.model";
import { MedicineModel } from "../hospital/catalog/catalog.models";
import { PatientModel } from "../patients/patient.model";
import {
  DispenseModel,
  IDispenseLine,
  MedicineBatchModel,
  MovementType,
  PurchaseModel,
  StockMovementModel,
} from "./pharmacy.models";

/**
 * PHARMACY SERVICE
 *   prescription queue → dispense (FEFO, in one transaction, never expired stock) → bill (event) →
 *   low-stock alert. Purchases receive stock; adjustments and write-offs keep the count honest.
 * The pharmacist sees what is needed to hand over medicines safely — patient name, code, age, gender,
 * allergies and the prescribed medicines — never the diagnosis or clinical notes.
 */

const SOLID_FORMS = new Set(["tablet", "capsule"]);
const UPDATED = "pharmacy:updated";
const notify = (payload: Record<string, unknown> = {}) => {
  emitToPermission("stock:read", UPDATED, payload);
  emitToPermission("dispense:create", UPDATED, payload);
};

export const medicineLabel = (m: { brandName: string; strength?: string | null; form?: string | null }) =>
  [m.brandName, m.strength, m.form].filter(Boolean).join(" ");

/** "1+0+1" → 2, "½+0+½" → 1, "0.5+0+1" → 1.5; anything else → null */
export const dosesPerDay = (pattern: string): number | null => {
  const parts = pattern.replace(/½/g, "0.5").replace(/¼/g, "0.25").split("+");
  let sum = 0;
  for (const p of parts) {
    const t = p.trim();
    const frac = t.match(/^(\d+)\/(\d+)$/);
    const n = frac ? Number(frac[1]) / Number(frac[2]) : Number(t);
    if (!Number.isFinite(n) || n < 0) return null;
    sum += n;
  }
  return sum > 0 ? sum : null;
};

/** Units to hand over for a prescription line: tablets/capsules = doses × days; bottles, tubes … = 1 */
export const suggestQuantity = (item: { dosePattern?: string; durationDays?: number | null; form?: string | null }) => {
  const perDay = item.dosePattern ? dosesPerDay(item.dosePattern) : null;
  if (!SOLID_FORMS.has(String(item.form ?? "").toLowerCase()) || !perDay || !item.durationDays) return 1;
  return Math.max(1, Math.ceil(perDay * item.durationDays));
};

const sellable = (today = todayInDhaka()) => ({ quantity: { $gt: 0 }, writtenOff: false, expiryDate: { $gte: today } });

/** Units on sale per medicine (unexpired), the earliest expiry and the current selling price */
export const stockFor = async (medicineIds: Types.ObjectId[]) => {
  if (!medicineIds.length)
    return new Map<string, { available: number; nearestExpiry: string | null; unitPrice: number | null }>();
  const rows = await MedicineBatchModel.aggregate([
    { $match: { medicine: { $in: medicineIds }, ...sellable() } },
    { $sort: { expiryDate: 1, receivedAt: 1 } },
    {
      $group: {
        _id: "$medicine",
        available: { $sum: "$quantity" },
        nearestExpiry: { $first: "$expiryDate" },
        unitPrice: { $first: "$unitPrice" },
      },
    },
  ]);
  return new Map(
    rows.map((r) => [
      String(r._id),
      { available: r.available, nearestExpiry: r.nearestExpiry, unitPrice: r.unitPrice },
    ]),
  );
};

const pharmacyPatient = (p: any) =>
  p?._id
    ? {
        id: String(p._id),
        name: p.name,
        nameBn: p.nameBn ?? null,
        patientCode: p.patientCode,
        gender: p.gender,
        age: p.dateOfBirth ? ageOn(p.dateOfBirth) : null,
        allergies: p.allergies ?? [],
      }
    : null;

const loadMedicineByName = async (brandName: string, strength?: string) => {
  const rx = new RegExp(`^${brandName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  const list = await MedicineModel.find({ brandName: rx, isActive: true }).lean<any[]>();
  return list.find((m) => !strength || (m.strength ?? "").toLowerCase() === strength.toLowerCase()) ?? list[0] ?? null;
};

// ------------------------------------------------------------------ prescription queue

type QueueStatus = "pending" | "partial" | "dispensed";

/** Units already handed over per prescription line of each visit */
const dispensedByVisit = async (visitIds: Types.ObjectId[]) => {
  const rows = await DispenseModel.aggregate([
    { $match: { visit: { $in: visitIds } } },
    { $unwind: "$items" },
    { $match: { "items.prescribedIndex": { $ne: null } } },
    { $group: { _id: { visit: "$visit", line: "$items.prescribedIndex" }, quantity: { $sum: "$items.quantity" } } },
  ]);
  const map = new Map<string, Map<number, number>>();
  for (const r of rows) {
    const key = String(r._id.visit);
    if (!map.has(key)) map.set(key, new Map());
    map.get(key)!.set(r._id.line, r.quantity);
  }
  return map;
};

const queueStatus = (lines: number, done?: Map<number, number>): QueueStatus =>
  !done || done.size === 0 ? "pending" : done.size >= lines ? "dispensed" : "partial";

export const prescriptionQueue = async (f: { status?: "pending" | "dispensed" | "all"; q?: string; days?: number }) => {
  const since = addDays(todayInDhaka(), -(f.days ?? 7));
  const query: Record<string, unknown> = {
    status: "closed",
    "prescription.0": { $exists: true },
    date: { $gte: since },
  };
  if (f.q) {
    const q = f.q.trim();
    if (/^RX-?\d+$/i.test(q)) query.prescriptionNo = q.toUpperCase().replace(/^RX-?/, "RX-");
    else {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const digits = q.replace(/\D/g, "");
      const patients = await PatientModel.find({
        $or: [
          { name: rx },
          { patientCode: rx },
          ...(digits.length >= 5 ? [{ phone: new RegExp(digits.slice(-10)) }] : []),
        ],
      })
        .select("_id")
        .limit(50)
        .lean();
      query.patient = { $in: patients.map((p) => p._id) };
    }
  }
  const visits = await VisitModel.find(query)
    .sort({ closedAt: -1 })
    .limit(100)
    .select("patient doctor date prescriptionNo prescription closedAt")
    .populate("patient", "name nameBn patientCode gender dateOfBirth allergies")
    .populate("doctor", "title name")
    .lean<any[]>();
  const done = await dispensedByVisit(visits.map((v) => v._id));
  const items = visits
    .map((v) => ({
      visitId: String(v._id),
      prescriptionNo: v.prescriptionNo,
      date: v.date,
      closedAt: v.closedAt,
      patient: pharmacyPatient(v.patient),
      doctor: v.doctor ? `${v.doctor.title ?? ""} ${v.doctor.name}`.trim() : null,
      medicines: v.prescription.length,
      preview: v.prescription
        .slice(0, 3)
        .map((p: any) => p.brandName)
        .join(", "),
      status: queueStatus(v.prescription.length, done.get(String(v._id))),
    }))
    .filter(
      (v) =>
        f.status === "all" ||
        !f.status ||
        (f.status === "dispensed" ? v.status === "dispensed" : v.status !== "dispensed"),
    );
  return items;
};

/** One prescription, ready to dispense: suggested quantities, what is already given, stock and price */
export const prescriptionForDispense = async (visitId: string) => {
  if (!Types.ObjectId.isValid(visitId)) throw new AppError(400, "Invalid prescription id.", "INVALID_ID");
  const v = await VisitModel.findById(visitId)
    .select("patient doctor date status prescriptionNo prescription")
    .populate("patient", "name nameBn patientCode gender dateOfBirth allergies")
    .populate("doctor", "title name")
    .lean<any>();
  if (!v || v.status !== "closed")
    throw new AppError(404, "Prescription not found. Only signed (closed) prescriptions can be dispensed.");

  // Match each line to the catalogue (doctors may have typed a free-text medicine)
  const medicines = await Promise.all(
    v.prescription.map(async (p: any) =>
      p.medicine ? MedicineModel.findById(p.medicine).lean<any>() : loadMedicineByName(p.brandName, p.strength),
    ),
  );
  const stock = await stockFor(medicines.filter(Boolean).map((m: any) => m._id));
  const done = (await dispensedByVisit([v._id])).get(String(v._id));

  return {
    visitId: String(v._id),
    prescriptionNo: v.prescriptionNo,
    date: v.date,
    doctor: v.doctor ? `${v.doctor.title ?? ""} ${v.doctor.name}`.trim() : null,
    patient: pharmacyPatient(v.patient),
    lines: v.prescription.map((p: any, index: number) => {
      const m: any = medicines[index];
      const s = m ? stock.get(String(m._id)) : undefined;
      const suggested = suggestQuantity({
        dosePattern: p.dosePattern,
        durationDays: p.durationDays,
        form: p.form || m?.form,
      });
      return {
        index,
        brandName: p.brandName,
        genericName: p.genericName || m?.genericName || "",
        strength: p.strength || m?.strength || "",
        form: p.form || m?.form || "",
        dosePattern: p.dosePattern,
        durationDays: p.durationDays ?? null,
        continued: Boolean(p.continued),
        instructionsBn: p.instructionsBn ?? "",
        medicineId: m ? String(m._id) : null,
        inCatalogue: Boolean(m),
        suggestedQuantity: suggested,
        alreadyDispensed: done?.get(index) ?? 0,
        available: s?.available ?? 0,
        nearestExpiry: s?.nearestExpiry ?? null,
        unitPrice: s?.unitPrice ?? null,
      };
    }),
    status: queueStatus(v.prescription.length, done),
  };
};

// ------------------------------------------------------------------ dispense

export type DispenseInput = {
  patientId: string;
  visitId?: string | null;
  items: { medicineId: string; quantity: number; prescribedIndex?: number | null }[];
  notes?: string;
};

/** Take `quantity` units of a medicine from its batches, earliest expiry first. Throws when short. */
const allocateFefo = async (medicineId: Types.ObjectId, quantity: number, label: string, session: ClientSession) => {
  const batches = await MedicineBatchModel.find({ medicine: medicineId, ...sellable() })
    .sort({ expiryDate: 1, receivedAt: 1 })
    .session(session);
  const available = batches.reduce((s, b) => s + b.quantity, 0);
  if (available < quantity)
    throw new AppError(409, `Not enough ${label} in stock: ${available} available, ${quantity} needed.`, "CONFLICT", {
      medicineId: String(medicineId),
      available,
    });
  const taken: { batch: any; quantity: number }[] = [];
  let left = quantity;
  for (const b of batches) {
    if (!left) break;
    const take = Math.min(left, b.quantity);
    // Guarded decrement: a parallel dispense cannot take the same units twice
    const updated = await MedicineBatchModel.findOneAndUpdate(
      { _id: b._id, quantity: { $gte: take } },
      { $inc: { quantity: -take } },
      { new: true, session },
    );
    if (!updated) throw new AppError(409, `Stock of ${label} changed a moment ago. Please try again.`, "CONFLICT");
    taken.push({ batch: updated, quantity: take });
    left -= take;
  }
  return taken;
};

export const dispense = async (req: Request, input: DispenseInput) => {
  if (!input.items.length) throw new AppError(400, "Add at least one medicine.", "VALIDATION_ERROR");
  const patient = await PatientModel.findById(input.patientId).select("_id name").lean<any>();
  if (!patient) throw new AppError(404, "Patient not found.");
  let visit: any = null;
  if (input.visitId) {
    visit = await VisitModel.findById(input.visitId).select("patient status prescriptionNo prescription").lean();
    if (!visit || visit.status !== "closed") throw new AppError(404, "Prescription not found.");
    if (String(visit.patient) !== String(patient._id))
      throw new AppError(400, "This prescription belongs to another patient.", "VALIDATION_ERROR");
  }
  const medicines = await MedicineModel.find({ _id: { $in: input.items.map((i) => i.medicineId) } }).lean<any[]>();
  const byId = new Map(medicines.map((m) => [String(m._id), m]));
  for (const i of input.items) {
    if (!byId.has(i.medicineId))
      throw new AppError(400, "A medicine on this list is not in the catalogue.", "VALIDATION_ERROR");
    if (
      i.prescribedIndex !== null &&
      i.prescribedIndex !== undefined &&
      (!visit || i.prescribedIndex >= visit.prescription.length)
    )
      throw new AppError(400, "That prescription line does not exist.", "VALIDATION_ERROR");
  }
  const before = await stockFor(medicines.map((m) => m._id));

  let created: any;
  const today = todayInDhaka();
  await mongoose.connection.transaction(async (session) => {
    const lines: IDispenseLine[] = [];
    const movements: any[] = [];
    for (const i of input.items) {
      const m = byId.get(i.medicineId);
      const label = medicineLabel(m);
      const taken = await allocateFefo(m._id, i.quantity, label, session);
      const lineTotal = taken.reduce((s, t) => s + t.quantity * t.batch.unitPrice, 0);
      lines.push({
        medicine: m._id,
        description: label,
        prescribedIndex: i.prescribedIndex ?? null,
        quantity: i.quantity,
        unitPrice: taken[0].batch.unitPrice,
        lineTotal,
        batches: taken.map((t) => ({
          batch: t.batch._id,
          batchNo: t.batch.batchNo,
          expiryDate: t.batch.expiryDate,
          quantity: t.quantity,
          unitPrice: t.batch.unitPrice,
        })),
      } as IDispenseLine);
      for (const t of taken)
        movements.push({
          medicine: m._id,
          batch: t.batch._id,
          type: "dispense",
          quantity: -t.quantity,
          balanceAfter: t.batch.quantity,
        });
    }
    const [doc] = await DispenseModel.create(
      [
        {
          dispenseNo: await nextCode("dispense", "DSP", session),
          patient: patient._id,
          visit: visit?._id ?? null,
          prescriptionNo: visit?.prescriptionNo ?? null,
          date: today,
          items: lines,
          total: lines.reduce((s, l) => s + l.lineTotal, 0),
          notes: input.notes ?? "",
          dispensedBy: req.user?.id ?? null,
          dispensedAt: new Date(),
        },
      ],
      { session },
    );
    await StockMovementModel.insertMany(
      movements.map((mv) => ({
        ...mv,
        reason: doc.dispenseNo,
        ref: { type: "dispense", id: doc._id },
        by: req.user?.id ?? null,
        at: new Date(),
      })),
      { session },
    );
    created = doc;
  });

  await recordAudit({
    req,
    action: "CREATE",
    entityType: "Dispense",
    entityId: created._id,
    after: {
      dispenseNo: created.dispenseNo,
      items: created.items.map((l: any) => ({ medicine: l.description, quantity: l.quantity })),
      total: created.total,
    },
    meta: { patientId: String(patient._id), visitId: visit ? String(visit._id) : null },
  });
  void publish("medicine.dispensed", {
    dispenseId: String(created._id),
    patientId: String(patient._id),
    visitId: visit ? String(visit._id) : null,
  });
  notify({ dispenseId: String(created._id) });
  void alertLowStock(medicines, before);
  return getDispense(String(created._id));
};

/** In-app alert to stock managers when a dispense takes a medicine to (or below) its reorder level */
const alertLowStock = async (medicines: any[], before: Awaited<ReturnType<typeof stockFor>>) => {
  try {
    const after = await stockFor(medicines.map((m) => m._id));
    for (const m of medicines) {
      const level = m.reorderLevel ?? 20;
      const was = before.get(String(m._id))?.available ?? 0;
      const now = after.get(String(m._id))?.available ?? 0;
      if (was > level && now <= level)
        await sendToStaff({
          permission: "stock:manage",
          source: "system",
          text:
            now === 0
              ? `📦 Out of stock: ${medicineLabel(m)}. Reorder now.`
              : `📦 Low stock: ${medicineLabel(m)} — ${now} left (reorder level ${level}).`,
          related: { type: "system", id: `stock:${m._id}` },
        });
    }
  } catch (err) {
    logger.warn({ err }, "Low-stock alert failed");
  }
};

const dispenseView = (d: any) => ({
  id: String(d._id),
  dispenseNo: d.dispenseNo,
  date: d.date,
  dispensedAt: d.dispensedAt,
  prescriptionNo: d.prescriptionNo,
  visitId: d.visit ? String(d.visit) : null,
  patient: pharmacyPatient(d.patient) ?? { id: String(d.patient) },
  items: d.items.map((l: any) => ({
    medicineId: String(l.medicine),
    description: l.description,
    prescribedIndex: l.prescribedIndex,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    lineTotal: l.lineTotal,
    batches: l.batches.map((b: any) => ({ batchNo: b.batchNo, expiryDate: b.expiryDate, quantity: b.quantity })),
  })),
  total: d.total,
  notes: d.notes,
  dispensedBy: d.dispensedBy?.name ?? null,
});

export const getDispense = async (id: string) => {
  if (!Types.ObjectId.isValid(id)) throw new AppError(400, "Invalid id.", "INVALID_ID");
  const d = await DispenseModel.findById(id)
    .populate("patient", "name nameBn patientCode gender dateOfBirth allergies")
    .populate("dispensedBy", "name")
    .lean<any>();
  if (!d) throw new AppError(404, "Dispense record not found.");
  return dispenseView(d);
};

export const listDispenses = async (f: { from?: string; to?: string; page: number; limit: number }) => {
  const query: Record<string, unknown> = {};
  if (f.from || f.to) query.date = { ...(f.from && { $gte: f.from }), ...(f.to && { $lte: f.to }) };
  const [items, total] = await Promise.all([
    DispenseModel.find(query)
      .sort({ dispensedAt: -1 })
      .skip((f.page - 1) * f.limit)
      .limit(f.limit)
      .populate("patient", "name nameBn patientCode gender dateOfBirth allergies")
      .populate("dispensedBy", "name")
      .lean<any[]>(),
    DispenseModel.countDocuments(query),
  ]);
  return { items: items.map(dispenseView), pagination: buildPagination(f.page, f.limit, total) };
};

// ------------------------------------------------------------------ stock

export type StockRow = {
  id: string;
  label: string;
  brandName: string;
  genericName: string;
  strength: string;
  form: string;
  reorderLevel: number;
  inStock: number;
  expiredQty: number;
  batchCount: number;
  nearestExpiry: string | null;
  unitPrice: number | null;
  stockValue: number;
  status: "out" | "low" | "ok" | "none";
};

export type StockFilter = "all" | "low" | "out" | "in_stock";

export const stockList = async (f: {
  q?: string;
  filter?: StockFilter;
  page: number;
  limit: number;
}): Promise<{ items: StockRow[]; pagination: ReturnType<typeof buildPagination> }> => {
  const today = todayInDhaka();
  const match: Record<string, unknown> = { isActive: true, isDeleted: { $ne: true } };
  if (f.q) {
    const rx = new RegExp(f.q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    match.$or = [{ brandName: rx }, { genericName: rx }];
  }
  const rows = await MedicineModel.aggregate([
    { $match: match },
    {
      $lookup: {
        from: MedicineBatchModel.collection.name,
        let: { id: "$_id" },
        pipeline: [{ $match: { $expr: { $eq: ["$medicine", "$$id"] } } }, { $sort: { expiryDate: 1 } }],
        as: "batches",
      },
    },
    {
      $addFields: {
        sellable: {
          $filter: {
            input: "$batches",
            as: "b",
            cond: {
              $and: [
                { $gt: ["$$b.quantity", 0] },
                { $eq: ["$$b.writtenOff", false] },
                { $gte: ["$$b.expiryDate", today] },
              ],
            },
          },
        },
        expired: {
          $filter: {
            input: "$batches",
            as: "b",
            cond: {
              $and: [
                { $gt: ["$$b.quantity", 0] },
                { $eq: ["$$b.writtenOff", false] },
                { $lt: ["$$b.expiryDate", today] },
              ],
            },
          },
        },
        everStocked: { $gt: [{ $size: "$batches" }, 0] },
        level: { $ifNull: ["$reorderLevel", 20] },
      },
    },
    {
      $addFields: {
        inStock: { $sum: "$sellable.quantity" },
        expiredQty: { $sum: "$expired.quantity" },
        nearestExpiry: { $first: "$sellable.expiryDate" },
        unitPrice: { $first: "$sellable.unitPrice" },
        stockValue: {
          $sum: { $map: { input: "$sellable", as: "b", in: { $multiply: ["$$b.quantity", "$$b.unitCost"] } } },
        },
        batchCount: { $size: "$sellable" },
      },
    },
    {
      $addFields: {
        // "none" = never bought (catalogue only); "out" = was stocked, nothing left to sell
        status: {
          $cond: [
            { $eq: ["$inStock", 0] },
            { $cond: ["$everStocked", "out", "none"] },
            { $cond: [{ $lte: ["$inStock", "$level"] }, "low", "ok"] },
          ],
        },
      },
    },
    ...(f.filter === "low"
      ? [{ $match: { status: "low" } }]
      : f.filter === "out"
        ? [{ $match: { status: "out" } }]
        : f.filter === "in_stock"
          ? [{ $match: { inStock: { $gt: 0 } } }]
          : []),
    // Problems first: out of stock, then low, then by name
    {
      $addFields: {
        rank: {
          $switch: {
            branches: [
              { case: { $eq: ["$status", "out"] }, then: 0 },
              { case: { $eq: ["$status", "low"] }, then: 1 },
              { case: { $eq: ["$status", "ok"] }, then: 2 },
            ],
            default: 3,
          },
        },
      },
    },
    { $sort: { rank: 1, brandName: 1 } },
    {
      $facet: {
        items: [
          { $skip: (f.page - 1) * f.limit },
          { $limit: f.limit },
          { $project: { batches: 0, sellable: 0, expired: 0 } },
        ],
        total: [{ $count: "n" }],
      },
    },
  ]);
  const page = rows[0];
  return {
    items: page.items.map((m: any) => ({
      id: String(m._id),
      label: medicineLabel(m),
      brandName: m.brandName,
      genericName: m.genericName,
      strength: m.strength ?? "",
      form: m.form,
      reorderLevel: m.level,
      inStock: m.inStock,
      expiredQty: m.expiredQty,
      batchCount: m.batchCount,
      nearestExpiry: m.nearestExpiry ?? null,
      unitPrice: m.unitPrice ?? null,
      stockValue: m.stockValue,
      status: m.status as "out" | "low" | "ok" | "none",
    })),
    pagination: buildPagination(f.page, f.limit, page.total[0]?.n ?? 0),
  };
};

export const medicineStock = async (id: string) => {
  if (!Types.ObjectId.isValid(id)) throw new AppError(400, "Invalid id.", "INVALID_ID");
  const m = await MedicineModel.findById(id).lean<any>();
  if (!m) throw new AppError(404, "Medicine not found.");
  const today = todayInDhaka();
  const [batches, movements] = await Promise.all([
    MedicineBatchModel.find({
      medicine: m._id,
      $or: [{ quantity: { $gt: 0 } }, { receivedAt: { $gte: new Date(Date.now() - 90 * 864e5) } }],
    })
      .sort({ expiryDate: 1 })
      .lean(),
    StockMovementModel.find({ medicine: m._id })
      .sort({ at: -1 })
      .limit(40)
      .populate("by", "name")
      .populate("batch", "batchNo")
      .lean<any[]>(),
  ]);
  return {
    id: String(m._id),
    label: medicineLabel(m),
    genericName: m.genericName,
    reorderLevel: m.reorderLevel ?? 20,
    batches: batches.map((b) => ({
      id: String(b._id),
      batchNo: b.batchNo,
      expiryDate: b.expiryDate,
      quantity: b.quantity,
      initialQuantity: b.initialQuantity,
      unitCost: b.unitCost,
      unitPrice: b.unitPrice,
      supplier: b.supplier,
      receivedAt: b.receivedAt,
      writtenOff: b.writtenOff,
      expired: b.expiryDate < today,
    })),
    movements: movements.map((mv) => ({
      type: mv.type as MovementType,
      quantity: mv.quantity,
      balanceAfter: mv.balanceAfter,
      batchNo: mv.batch?.batchNo ?? "",
      reason: mv.reason,
      by: mv.by?.name ?? null,
      at: mv.at,
    })),
  };
};

export const setReorderLevel = async (req: Request, id: string, level: number) => {
  const m = await MedicineModel.findById(id);
  if (!m) throw new AppError(404, "Medicine not found.");
  const before = (m as any).reorderLevel ?? 20;
  (m as any).reorderLevel = level;
  await m.save();
  await recordAudit({
    req,
    action: "UPDATE",
    entityType: "Medicine",
    entityId: m._id,
    before: { reorderLevel: before },
    after: { reorderLevel: level },
  });
  notify({ medicineId: id });
  return medicineStock(id);
};

/** Count correction (+/−) or removal (write-off) of one batch, always with a reason */
export const adjustBatch = async (
  req: Request,
  batchId: string,
  input: { change: number; reason: string; writeOff?: boolean },
) => {
  if (!Types.ObjectId.isValid(batchId)) throw new AppError(400, "Invalid batch.", "INVALID_ID");
  const b = await MedicineBatchModel.findById(batchId);
  if (!b) throw new AppError(404, "Batch not found.");
  const before = b.quantity;
  const change = input.writeOff ? -b.quantity : input.change;
  if (!input.writeOff && change === 0) throw new AppError(400, "Enter a change other than zero.", "VALIDATION_ERROR");
  if (before + change < 0) throw new AppError(409, `Only ${before} units are in this batch.`, "CONFLICT");
  await mongoose.connection.transaction(async (session) => {
    const updated = await MedicineBatchModel.findOneAndUpdate(
      { _id: b._id, quantity: before },
      { $inc: { quantity: change }, ...(input.writeOff && { $set: { writtenOff: true } }) },
      { new: true, session },
    );
    if (!updated) throw new AppError(409, "This batch changed a moment ago. Refresh and try again.", "CONFLICT");
    await StockMovementModel.create(
      [
        {
          medicine: b.medicine,
          batch: b._id,
          type: input.writeOff ? "write_off" : "adjust",
          quantity: change,
          balanceAfter: updated.quantity,
          reason: input.reason,
          ref: { type: null, id: null },
          by: req.user?.id ?? null,
          at: new Date(),
        },
      ],
      { session },
    );
  });
  await recordAudit({
    req,
    action: "UPDATE",
    entityType: "MedicineBatch",
    entityId: b._id,
    before: { quantity: before },
    after: { quantity: before + change, writtenOff: Boolean(input.writeOff) },
    meta: { reason: input.reason, event: input.writeOff ? "write_off" : "adjust" },
  });
  notify({ medicineId: String(b.medicine) });
  return medicineStock(String(b.medicine));
};

// ------------------------------------------------------------------ expiry

export const expiryReport = async (days = 90) => {
  const today = todayInDhaka();
  const until = addDays(today, days);
  const batches = await MedicineBatchModel.find({
    quantity: { $gt: 0 },
    writtenOff: false,
    expiryDate: { $lte: until },
  })
    .sort({ expiryDate: 1 })
    .populate("medicine", "brandName strength form genericName")
    .lean<any[]>();
  const in30 = addDays(today, 30);
  const items = batches.map((b) => ({
    batchId: String(b._id),
    medicineId: String(b.medicine?._id ?? b.medicine),
    label: b.medicine ? medicineLabel(b.medicine) : "Unknown medicine",
    genericName: b.medicine?.genericName ?? "",
    batchNo: b.batchNo,
    expiryDate: b.expiryDate,
    quantity: b.quantity,
    value: b.quantity * b.unitCost,
    supplier: b.supplier,
    bucket: (b.expiryDate < today ? "expired" : b.expiryDate <= in30 ? "30" : "90") as "expired" | "30" | "90",
  }));
  const sum = (bucket: string) => items.filter((i) => i.bucket === bucket);
  return {
    days,
    summary: {
      expired: { batches: sum("expired").length, value: sum("expired").reduce((s, i) => s + i.value, 0) },
      within30: { batches: sum("30").length, value: sum("30").reduce((s, i) => s + i.value, 0) },
      within90: { batches: sum("90").length, value: sum("90").reduce((s, i) => s + i.value, 0) },
    },
    items,
  };
};

// ------------------------------------------------------------------ purchases

export type PurchaseInput = {
  supplier: string;
  supplierInvoiceNo?: string;
  date: string;
  notes?: string;
  items: {
    medicineId: string;
    batchNo: string;
    expiryDate: string;
    quantity: number;
    unitCost: number;
    unitPrice: number;
  }[];
};

export const createPurchase = async (req: Request, input: PurchaseInput) => {
  if (!input.items.length) throw new AppError(400, "Add at least one medicine.", "VALIDATION_ERROR");
  if (input.date > todayInDhaka())
    throw new AppError(400, "The delivery date cannot be in the future.", "VALIDATION_ERROR");
  const medicines = await MedicineModel.find({ _id: { $in: input.items.map((i) => i.medicineId) } }).lean<any[]>();
  const byId = new Map(medicines.map((m) => [String(m._id), m]));
  input.items.forEach((i, n) => {
    if (!byId.has(i.medicineId))
      throw new AppError(400, `Line ${n + 1}: the medicine is not in the catalogue.`, "VALIDATION_ERROR");
    if (i.expiryDate <= input.date)
      throw new AppError(400, `Line ${n + 1}: this batch is already expired.`, "VALIDATION_ERROR");
  });

  let created: any;
  await mongoose.connection.transaction(async (session) => {
    const purchaseNo = await nextCode("purchase", "PUR", session);
    const purchaseId = new Types.ObjectId();
    const receivedAt = new Date();
    const batches = await MedicineBatchModel.insertMany(
      input.items.map((i) => ({
        medicine: i.medicineId,
        batchNo: i.batchNo.trim().toUpperCase(),
        expiryDate: i.expiryDate,
        quantity: i.quantity,
        initialQuantity: i.quantity,
        unitCost: i.unitCost,
        unitPrice: i.unitPrice,
        purchase: purchaseId,
        supplier: input.supplier.trim(),
        receivedAt,
        writtenOff: false,
      })),
      { session },
    );
    await StockMovementModel.insertMany(
      batches.map((b) => ({
        medicine: b.medicine,
        batch: b._id,
        type: "purchase",
        quantity: b.quantity,
        balanceAfter: b.quantity,
        reason: purchaseNo,
        ref: { type: "purchase", id: purchaseId },
        by: req.user?.id ?? null,
        at: receivedAt,
      })),
      { session },
    );
    const items = input.items.map((i, n) => ({
      medicine: i.medicineId,
      description: medicineLabel(byId.get(i.medicineId)),
      batchNo: batches[n].batchNo,
      expiryDate: i.expiryDate,
      quantity: i.quantity,
      unitCost: i.unitCost,
      unitPrice: i.unitPrice,
      lineTotal: i.quantity * i.unitCost,
      batch: batches[n]._id,
    }));
    [created] = await PurchaseModel.create(
      [
        {
          _id: purchaseId,
          purchaseNo,
          supplier: input.supplier.trim(),
          supplierInvoiceNo: input.supplierInvoiceNo?.trim() ?? "",
          date: input.date,
          items,
          total: items.reduce((s, l) => s + l.lineTotal, 0),
          notes: input.notes ?? "",
          receivedBy: req.user?.id ?? null,
        },
      ],
      { session },
    );
  });
  await recordAudit({
    req,
    action: "CREATE",
    entityType: "Purchase",
    entityId: created._id,
    after: {
      purchaseNo: created.purchaseNo,
      supplier: created.supplier,
      lines: created.items.length,
      total: created.total,
    },
  });
  notify({ purchaseId: String(created._id) });
  return getPurchase(String(created._id));
};

const purchaseView = (p: any) => ({
  id: String(p._id),
  purchaseNo: p.purchaseNo,
  supplier: p.supplier,
  supplierInvoiceNo: p.supplierInvoiceNo,
  date: p.date,
  items: p.items.map((l: any) => ({
    medicineId: String(l.medicine),
    description: l.description,
    batchNo: l.batchNo,
    expiryDate: l.expiryDate,
    quantity: l.quantity,
    unitCost: l.unitCost,
    unitPrice: l.unitPrice,
    lineTotal: l.lineTotal,
  })),
  total: p.total,
  notes: p.notes,
  receivedBy: p.receivedBy?.name ?? null,
  createdAt: p.createdAt,
});

export const getPurchase = async (id: string) => {
  if (!Types.ObjectId.isValid(id)) throw new AppError(400, "Invalid id.", "INVALID_ID");
  const p = await PurchaseModel.findById(id).populate("receivedBy", "name").lean<any>();
  if (!p) throw new AppError(404, "Purchase not found.");
  return purchaseView(p);
};

export const listPurchases = async (f: { q?: string; from?: string; to?: string; page: number; limit: number }) => {
  const query: Record<string, unknown> = {};
  if (f.q) {
    const rx = new RegExp(f.q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    query.$or = [{ supplier: rx }, { purchaseNo: rx }, { supplierInvoiceNo: rx }];
  }
  if (f.from || f.to) query.date = { ...(f.from && { $gte: f.from }), ...(f.to && { $lte: f.to }) };
  const [items, total] = await Promise.all([
    PurchaseModel.find(query)
      .sort({ date: -1, createdAt: -1 })
      .skip((f.page - 1) * f.limit)
      .limit(f.limit)
      .populate("receivedBy", "name")
      .lean<any[]>(),
    PurchaseModel.countDocuments(query),
  ]);
  return { items: items.map(purchaseView), pagination: buildPagination(f.page, f.limit, total) };
};

/** Suppliers used before (for the purchase form's suggestions) */
export const suppliers = async () => (await PurchaseModel.distinct("supplier")).sort();

// ------------------------------------------------------------------ dashboard

export const pharmacySummary = async () => {
  const today = todayInDhaka();
  const [queue, dispensedToday, stock, expiry] = await Promise.all([
    prescriptionQueue({ status: "pending", days: 2 }),
    DispenseModel.aggregate([
      { $match: { date: today } },
      { $group: { _id: null, count: { $sum: 1 }, value: { $sum: "$total" } } },
    ]),
    stockList({ filter: "all", page: 1, limit: 10_000 }),
    expiryReport(30),
  ]);
  return {
    pendingPrescriptions: queue.length,
    dispensedToday: dispensedToday[0]?.count ?? 0,
    dispensedValueToday: dispensedToday[0]?.value ?? 0,
    lowStock: stock.items.filter((m) => m.status === "low").length,
    outOfStock: stock.items.filter((m) => m.status === "out").length,
    expiring30: expiry.summary.within30.batches,
    expired: expiry.summary.expired.batches,
    stockValue: stock.items.reduce((s, m) => s + m.stockValue, 0),
    queue: queue.slice(0, 6),
    attention: stock.items.filter((m) => m.status === "out" || m.status === "low").slice(0, 8),
  };
};
