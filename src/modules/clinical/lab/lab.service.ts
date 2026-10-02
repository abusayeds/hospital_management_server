/* eslint-disable @typescript-eslint/no-explicit-any */
import { Request } from "express";
import { ClientSession, Types } from "mongoose";
import { roleHasPermission } from "../../../config/permissions";
import { maskName, registerDocumentResolver } from "../../../documents/verify.route";
import AppError from "../../../errors/AppError";
import { publish } from "../../../events/bus";
import { buildPagination } from "../../../interface/global.interface";
import { assertCanAccess } from "../../../middlewares/authorize";
import { nextCode } from "../../../models/counter.model";
import { flagLabValue, LabFlag } from "../../../shared/clinical-rules";
import { emitToPermission, emitToRoom } from "../../../sockets";
import { ageOn, todayInDhaka } from "../../../utils/date";
import { escapeRegex } from "../../../utils/escapeRegex";
import { recordAudit } from "../../audit/audit.service";
import { LabTestModel } from "../../hospital/catalog/catalog.models";
import { getSettings } from "../../hospital/settings/settings.service";
import { PatientModel } from "../../patients/patient.model";
import { assertEmrAccess, doctorIdOf } from "../emr-access";
import { VisitModel } from "../visits/visit.model";
import { LabOrderDocument, LabOrderModel, LabResult, LabStatus } from "./labOrder.model";

/**
 * LAB SERVICE — orders, samples, results, four-eyes verification and hand-over.
 *
 * Who sees what:
 *  - lab staff (lab_order:read) see every order and every result they work on;
 *  - doctors see orders of their own patients (EMR rule) and results only once VERIFIED;
 *  - reception (lab_order:read + lab_report:deliver) sees statuses and prints ready reports.
 */

type User = NonNullable<Request["user"]>;
const RELEASED: LabStatus[] = ["ready", "delivered"];
const FLAG_RANK: Record<LabFlag, number> = { normal: 0, low: 1, high: 1, abnormal: 1, critical: 2 };

// ------------------------------------------------------------------ views

const isLabStaff = (user: User) =>
  roleHasPermission(user.role, "lab_result:create") || roleHasPermission(user.role, "lab_report:verify");

/** Results are shown to lab staff while they work, to everyone else only after verification */
const canSeeResults = (user: User, status: LabStatus) =>
  isLabStaff(user) || (RELEASED.includes(status) && roleHasPermission(user.role, "lab_report:read"));

const who = (u: any) => (u?.name ? { id: String(u._id), name: u.name } : u ? { id: String(u) } : null);

export const toLabOrderView = (o: any, user: User) => {
  const showResults = canSeeResults(user, o.status);
  return {
    id: String(o._id),
    orderNo: o.orderNo,
    date: o.date,
    status: o.status as LabStatus,
    priority: o.priority,
    clinicalNote: o.clinicalNote ?? "",
    worstFlag: showResults ? (o.worstFlag ?? null) : null,
    tests: (o.tests ?? []).map((t: any) => ({
      labTestId: String(t.labTest),
      name: t.name,
      code: t.code,
      sampleType: t.sampleType ?? "",
      comment: showResults ? (t.comment ?? "") : "",
      results: showResults
        ? (t.results ?? []).map((r: any) => ({
            name: r.name,
            unit: r.unit ?? "",
            normalMin: r.normalMin ?? null,
            normalMax: r.normalMax ?? null,
            normalText: r.normalText ?? "",
            value: r.value ?? "",
            flag: r.flag ?? null,
          }))
        : [],
    })),
    patient: o.patient?._id
      ? {
          id: String(o.patient._id),
          name: o.patient.name,
          nameBn: o.patient.nameBn,
          patientCode: o.patient.patientCode,
          gender: o.patient.gender,
          age: ageOn(o.patient.dateOfBirth),
        }
      : { id: String(o.patient) },
    doctor: o.doctor?._id
      ? { id: String(o.doctor._id), displayName: `${o.doctor.title ?? ""} ${o.doctor.name}`.trim() }
      : o.doctor
        ? { id: String(o.doctor) }
        : null,
    visitId: o.visit ? String(o.visit) : null,
    sampleCollectedAt: o.sampleCollectedAt ?? null,
    resultsEnteredBy: who(o.resultsEnteredBy),
    resultsEnteredAt: o.resultsEnteredAt ?? null,
    verifiedBy: who(o.verifiedBy),
    verifiedAt: o.verifiedAt ?? null,
    deliveredAt: o.deliveredAt ?? null,
    cancelReason: o.cancelReason ?? null,
    history: (o.history ?? []).map((h: any) => ({ status: h.status, at: h.at, note: h.note ?? "" })),
    createdAt: o.createdAt,
  };
};
export type LabOrderView = ReturnType<typeof toLabOrderView>;

const POPULATE = [
  { path: "patient", select: "name nameBn patientCode gender dateOfBirth" },
  { path: "doctor", select: "title name" },
  { path: "resultsEnteredBy", select: "name" },
  { path: "verifiedBy", select: "name" },
];

const loadOrder = async (id: string, session?: ClientSession) => {
  if (!Types.ObjectId.isValid(id)) throw new AppError(400, "Invalid lab order id.", "INVALID_ID");
  const o = (await LabOrderModel.findById(id).session(session ?? null)) as LabOrderDocument | null;
  if (!o) throw new AppError(404, "Lab order not found.");
  return o;
};

/** Non-lab users (doctors) only reach orders of patients whose record they may open */
const assertOrderAccess = async (req: Request, order: LabOrderDocument) => {
  if (roleHasPermission(req.user!.role, "lab_order:read")) return;
  await assertEmrAccess(req, String(order.patient));
};

// ------------------------------------------------------------------ notifications

const notify = (o: LabOrderDocument) => {
  const signal = { labOrderId: String(o._id), orderNo: o.orderNo, status: o.status, patientId: String(o.patient) };
  emitToPermission("lab_order:read", "lab:updated", signal);
  if (o.doctor) emitToRoom(`doctor:${String(o.doctor)}`, "lab:updated", signal);
};

const move = (o: LabOrderDocument, to: LabStatus, req: Request, note?: string) => {
  o.status = to;
  o.history.push({ status: to, at: new Date(), by: new Types.ObjectId(req.user!.id), ...(note && { note }) });
  o.updatedBy = new Types.ObjectId(req.user!.id);
};

const assertStatus = (o: LabOrderDocument, allowed: LabStatus[], action: string) => {
  if (!allowed.includes(o.status))
    throw new AppError(409, `Cannot ${action}: the order is "${o.status.replace(/_/g, " ")}".`, "CONFLICT", {
      status: o.status,
    });
};

const finish = async (req: Request, o: LabOrderDocument, from: LabStatus, meta?: Record<string, unknown>) => {
  await recordAudit({
    req,
    action: "UPDATE",
    entityType: "LabOrder",
    entityId: o._id,
    before: { status: from },
    after: { status: o.status },
    meta: { orderNo: o.orderNo, ...meta },
  });
  notify(o);
  return toLabOrderView(await o.populate(POPULATE), req.user!);
};

// ------------------------------------------------------------------ ordering

/** Build the order lines from the catalogue: every parameter becomes an empty result row */
const buildTests = async (labTestIds: string[], session?: ClientSession) => {
  const tests = await LabTestModel.find({ _id: { $in: labTestIds }, isActive: true }).session(session ?? null);
  return tests.map((t: any) => ({
    labTest: t._id,
    name: t.name,
    code: t.code,
    sampleType: t.sampleType,
    price: t.price,
    results: (t.parameters?.length ? t.parameters : [{ name: "Result" }]).map((p: any) => ({
      name: p.name,
      unit: p.unit ?? "",
      normalMin: p.normalMin ?? null,
      normalMax: p.normalMax ?? null,
      normalText: p.normalText ?? "",
      value: "",
      flag: null,
    })),
  }));
};

/** Tests of this visit that are already ordered (not cancelled) */
const alreadyOrdered = async (visitId: Types.ObjectId | string, session?: ClientSession) => {
  const orders = await LabOrderModel.find({ visit: visitId, status: { $ne: "cancelled" } })
    .select("tests.labTest")
    .session(session ?? null)
    .lean<any[]>();
  return new Set(orders.flatMap((o) => o.tests.map((t: any) => String(t.labTest))));
};

type CreateInput = {
  visit: any;
  labTestIds: string[];
  priority?: "routine" | "urgent";
  note?: string;
  userId: string;
  session?: ClientSession;
};

/** Create one order for the tests of a visit that are not ordered yet. Returns null when nothing is new. */
export const createOrderForVisit = async ({ visit, labTestIds, priority, note, userId, session }: CreateInput) => {
  const done = await alreadyOrdered(visit._id, session);
  const fresh = [...new Set(labTestIds)].filter((id) => !done.has(id));
  if (!fresh.length) return null;
  const tests = await buildTests(fresh, session);
  if (!tests.length) return null;
  const [order] = (await LabOrderModel.create(
    [
      {
        orderNo: await nextCode("lab_order", "LAB", session),
        patient: visit.patient,
        visit: visit._id,
        doctor: visit.doctor,
        date: todayInDhaka(),
        priority: priority ?? "routine",
        status: "ordered",
        tests,
        clinicalNote: note ?? (visit.provisionalDiagnosis || visit.finalDiagnosis || ""),
        orderedBy: userId,
        createdBy: userId,
        history: [{ status: "ordered", at: new Date(), by: userId }],
      },
    ],
    { session },
  )) as LabOrderDocument[];
  return order;
};

/** Call AFTER the order is committed: audit, live update, domain event */
export const announceNewOrder = async (req: Request, order: LabOrderDocument) => {
  await recordAudit({
    req,
    action: "CREATE",
    entityType: "LabOrder",
    entityId: order._id,
    after: { orderNo: order.orderNo, tests: order.tests.map((t) => t.code), priority: order.priority },
    meta: { visitId: order.visit ? String(order.visit) : null, patientId: String(order.patient) },
  });
  notify(order);
  void publish("lab.order_created", {
    labOrderId: String(order._id),
    visitId: order.visit ? String(order.visit) : null,
    patientId: String(order.patient),
    doctorId: order.doctor ? String(order.doctor) : null,
    priority: order.priority,
  });
};

/** The doctor sends tests to the lab now (e.g. before sending the patient out for samples) */
export const orderTests = async (
  req: Request,
  input: { visitId: string; labTestIds: string[]; priority?: "routine" | "urgent"; note?: string },
) => {
  if (!Types.ObjectId.isValid(input.visitId)) throw new AppError(400, "Invalid visit id.", "INVALID_ID");
  const visit = await VisitModel.findById(input.visitId);
  if (!visit) throw new AppError(404, "Visit not found.");
  const me = await doctorIdOf(req.user!);
  await assertCanAccess(req, Boolean(me) && me === String(visit.doctor), {
    entityType: "Visit",
    entityId: input.visitId,
  });
  const order = await createOrderForVisit({ visit, ...input, userId: req.user!.id });
  if (!order) throw new AppError(409, "These tests are already ordered for this visit.", "CONFLICT");
  await announceNewOrder(req, order);
  return toLabOrderView(await order.populate(POPULATE), req.user!);
};

// ------------------------------------------------------------------ lab work

export const collectSample = async (req: Request, id: string) => {
  const o = await loadOrder(id);
  assertStatus(o, ["ordered"], "collect the sample");
  const from = o.status;
  move(o, "sample_collected", req);
  o.sampleCollectedAt = new Date();
  o.sampleCollectedBy = new Types.ObjectId(req.user!.id);
  await o.save();
  void publish("lab.sample_collected", { labOrderId: String(o._id), patientId: String(o.patient) });
  return finish(req, o, from);
};

type ResultsInput = { tests: { labTestId: string; results: { name: string; value: string }[]; comment?: string }[] };

/** Save (draft) results. Flags are computed on the server from the catalogue ranges. */
export const saveResults = async (req: Request, id: string, input: ResultsInput) => {
  const o = await loadOrder(id);
  assertStatus(o, ["sample_collected", "processing"], "enter results");
  const from = o.status;
  for (const t of input.tests) {
    const line = o.tests.find((x) => String(x.labTest) === t.labTestId);
    if (!line) throw new AppError(400, `Test ${t.labTestId} is not part of this order.`, "VALIDATION_ERROR");
    for (const r of t.results) {
      const row = line.results.find((x) => x.name === r.name);
      if (!row) throw new AppError(400, `"${r.name}" is not a parameter of ${line.name}.`, "VALIDATION_ERROR");
      row.value = r.value.trim();
      row.flag = flagLabValue(row.value, row) as LabResult["flag"];
    }
    if (t.comment !== undefined) line.comment = t.comment;
  }
  o.markModified("tests");
  const flags = o.tests.flatMap((t) => t.results.map((r) => r.flag)).filter(Boolean) as LabFlag[];
  o.worstFlag = flags.length ? flags.reduce((a, b) => (FLAG_RANK[b] > FLAG_RANK[a] ? b : a), "normal") : null;
  o.resultsEnteredBy = new Types.ObjectId(req.user!.id);
  o.resultsEnteredAt = new Date();
  if (o.status === "sample_collected") move(o, "processing", req);
  else o.updatedBy = new Types.ObjectId(req.user!.id);
  await o.save();
  return finish(req, o, from, { event: "results_saved" });
};

export const submitForVerification = async (req: Request, id: string) => {
  const o = await loadOrder(id);
  assertStatus(o, ["processing"], "submit for verification");
  const missing = o.tests.flatMap((t) => t.results.filter((r) => !r.value?.trim()).map((r) => `${t.name}: ${r.name}`));
  if (missing.length)
    throw new AppError(
      400,
      `Enter every result before submitting. Missing: ${missing.join(", ")}.`,
      "VALIDATION_ERROR",
    );
  const from = o.status;
  move(o, "awaiting_verification", req);
  await o.save();
  return finish(req, o, from);
};

/**
 * FOUR-EYES VERIFICATION: a second qualified person checks the results and releases them.
 * With the rule on, the person who entered the results cannot verify them (refused + audited).
 */
export const verifyResults = async (req: Request, id: string) => {
  const o = await loadOrder(id);
  assertStatus(o, ["awaiting_verification"], "verify");
  const { labFourEyes } = await getSettings();
  if (labFourEyes !== false && String(o.resultsEnteredBy) === req.user!.id) {
    await recordAudit({
      req,
      action: "PERMISSION_DENIED",
      entityType: "LabOrder",
      entityId: o._id,
      meta: { reason: "four_eyes", orderNo: o.orderNo },
    });
    throw new AppError(
      403,
      "Four-eyes rule: results must be verified by a different person than the one who entered them.",
      "FOUR_EYES_REQUIRED",
    );
  }
  const from = o.status;
  move(o, "ready", req, "verified");
  o.verifiedBy = new Types.ObjectId(req.user!.id);
  o.verifiedAt = new Date();
  await o.save();
  const view = await finish(req, o, from, { event: "verified", worstFlag: o.worstFlag });
  void publish("lab.report_ready", {
    labOrderId: String(o._id),
    patientId: String(o.patient?._id ?? o.patient),
    doctorId: o.doctor ? String(o.doctor?._id ?? o.doctor) : null,
    visitId: o.visit ? String(o.visit) : null,
  });
  if (o.doctor)
    emitToRoom(`doctor:${String(o.doctor?._id ?? o.doctor)}`, "lab:report_ready", {
      labOrderId: String(o._id),
      orderNo: o.orderNo,
      patientId: String(o.patient?._id ?? o.patient),
      worstFlag: o.worstFlag ?? null,
    });
  return view;
};

/** The verifier sends results back with a reason (e.g. "haemolysed sample — repeat K+") */
export const rejectResults = async (req: Request, id: string, reason: string) => {
  const o = await loadOrder(id);
  assertStatus(o, ["awaiting_verification"], "send back");
  const from = o.status;
  move(o, "processing", req, `rejected: ${reason}`);
  await o.save();
  return finish(req, o, from, { event: "rejected", reason });
};

export const deliverReport = async (req: Request, id: string) => {
  const o = await loadOrder(id);
  assertStatus(o, ["ready"], "hand over the report");
  const from = o.status;
  move(o, "delivered", req);
  o.deliveredAt = new Date();
  o.deliveredBy = new Types.ObjectId(req.user!.id);
  await o.save();
  return finish(req, o, from);
};

export const cancelOrder = async (req: Request, id: string, reason: string) => {
  const o = await loadOrder(id);
  await assertOrderAccess(req, o);
  assertStatus(o, ["ordered", "sample_collected", "processing"], "cancel");
  if (!roleHasPermission(req.user!.role, "lab_result:create")) {
    const me = await doctorIdOf(req.user!);
    await assertCanAccess(req, Boolean(me) && me === String(o.doctor), { entityType: "LabOrder", entityId: id });
  }
  const from = o.status;
  move(o, "cancelled", req, reason);
  o.cancelReason = reason;
  await o.save();
  return finish(req, o, from, { reason });
};

// ------------------------------------------------------------------ reading

export const getOrder = async (req: Request, id: string) => {
  const o = await loadOrder(id);
  await assertOrderAccess(req, o);
  const view = toLabOrderView(await o.populate(POPULATE), req.user!);
  if (view.tests.some((t: { results: unknown[] }) => t.results.length))
    await recordAudit({ req, action: "VIEW", entityType: "LabOrder", entityId: o._id, meta: { orderNo: o.orderNo } });
  return view;
};

export type ListFilters = {
  status?: LabStatus[];
  q?: string;
  date?: string;
  mine?: boolean;
  page: number;
  limit: number;
};

export const listOrders = async (req: Request, f: ListFilters) => {
  const filter: Record<string, unknown> = {};
  const labOrReception = roleHasPermission(req.user!.role, "lab_order:read");
  if (f.mine || !labOrReception) {
    // Doctors: only the orders they made
    const me = await doctorIdOf(req.user!);
    if (!me) return { items: [], pagination: buildPagination(f.page, f.limit, 0) };
    filter.doctor = me;
  }
  if (f.status?.length) filter.status = { $in: f.status };
  if (f.date) filter.date = f.date;
  if (f.q) {
    const rx = new RegExp(escapeRegex(f.q.trim()), "i");
    const patients = await PatientModel.find({ $or: [{ name: rx }, { patientCode: rx }] })
      .select("_id")
      .limit(50)
      .lean<any[]>();
    filter.$or = [{ orderNo: rx }, { patient: { $in: patients.map((p) => p._id) } }];
  }
  const [items, total] = await Promise.all([
    LabOrderModel.find(filter)
      .sort({ priority: -1, createdAt: 1 })
      .skip((f.page - 1) * f.limit)
      .limit(f.limit)
      .populate(POPULATE)
      .lean<any[]>(),
    LabOrderModel.countDocuments(filter),
  ]);
  return {
    items: items.map((o) => toLabOrderView(o, req.user!)),
    pagination: buildPagination(f.page, f.limit, total),
  };
};

/** The lab's work board: everything not finished, urgent first, oldest first */
export const labBoard = async (req: Request) => {
  const since = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const items = await LabOrderModel.find({
    $or: [
      { status: { $in: ["ordered", "sample_collected", "processing", "awaiting_verification"] } },
      { status: "ready", verifiedAt: { $gte: since } },
    ],
  })
    .sort({ priority: -1, createdAt: 1 })
    .limit(300)
    .populate(POPULATE)
    .lean<any[]>();
  return items.map((o) => toLabOrderView(o, req.user!));
};

/** A patient's lab history for the EMR (verified results only for doctors) */
export const patientLabOrders = async (req: Request, patientId: string) => {
  await assertEmrAccess(req, patientId);
  const items = await LabOrderModel.find({ patient: patientId, status: { $ne: "cancelled" } })
    .sort({ createdAt: -1 })
    .limit(50)
    .populate(POPULATE)
    .lean<any[]>();
  return items.map((o) => toLabOrderView(o, req.user!));
};

/** `ownerCheck` (patient portal) replaces the staff access check: it throws unless the patient is the caller's */
export const loadOrderForReport = async (req: Request, id: string, ownerCheck?: (patientId: string) => void) => {
  const o = await loadOrder(id);
  if (ownerCheck) ownerCheck(String(o.patient));
  else await assertOrderAccess(req, o);
  if (!RELEASED.includes(o.status))
    throw new AppError(409, "The report can be printed after the results are verified.", "CONFLICT");
  await o.populate([...POPULATE, { path: "doctor", select: "title name degrees" }]);
  return o;
};

// The QR on a printed lab report is checked here (public verify page)
registerDocumentResolver("LAB", async (orderNo) => {
  const o = await LabOrderModel.findOne({ orderNo, status: { $in: RELEASED } })
    .populate("patient", "name dateOfBirth")
    .populate("verifiedBy", "name")
    .lean<any>();
  if (!o) return null;
  return {
    type: "lab_report",
    number: orderNo,
    date: o.date,
    issuedBy: `Laboratory${o.verifiedBy?.name ? ` — verified by ${o.verifiedBy.name}` : ""}`,
    patient: maskName(o.patient.name),
    patientAge: ageOn(o.patient.dateOfBirth, o.date),
    signedAt: o.verifiedAt ?? null,
    corrections: 0,
  };
});

export const labService = {
  orderTests,
  collectSample,
  saveResults,
  submitForVerification,
  verifyResults,
  rejectResults,
  deliverReport,
  cancelOrder,
  getOrder,
  listOrders,
  labBoard,
  patientLabOrders,
};
