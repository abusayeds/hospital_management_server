/* eslint-disable @typescript-eslint/no-explicit-any */
import { PipelineStage, Types } from "mongoose";
import AppError from "../../errors/AppError";
import { addDays, daysBetween, todayInDhaka } from "../../utils/date";
import { ChatMessageModel } from "../assistant/chatMessage.model";
import { InvoiceModel } from "../billing/invoice.model";
import { LabOrderModel } from "../clinical/lab/labOrder.model";
import { VitalsModel } from "../clinical/vitals/vitals.model";
import { AppointmentModel } from "../hospital/appointment/appointment.model";
import { getTodayBoard } from "../hospital/queue/queue.service";
import { getSettings } from "../hospital/settings/settings.service";

/**
 * MANAGEMENT ANALYTICS — read-only aggregations for the dashboard and the AI daily report.
 *
 * Privacy: results contain counts, money totals and doctor/department/test NAMES only — never
 * a patient name, phone, code, diagnosis or lab value. Every function accepts the same filters,
 * and every heavy query uses an index ({date, doctor, status}, {source, date}, {createdAt, status}).
 * Dates are Dhaka YYYY-MM-DD strings (inclusive range).
 */

export type Filters = {
  from: string;
  to: string;
  doctorIds?: string[];
  departmentIds?: string[];
  sources?: string[];
  labCategory?: string;
};

const MAX_RANGE_DAYS = 366;

export const normalizeRange = (f: Partial<Filters>): Filters => {
  const to = f.to ?? todayInDhaka();
  const from = f.from ?? addDays(to, -29);
  if (from > to) throw new AppError(400, "The start date must be before the end date.", "VALIDATION_ERROR");
  if (daysBetween(from, to) > MAX_RANGE_DAYS)
    throw new AppError(400, "Choose a range of at most one year.", "VALIDATION_ERROR");
  return { ...f, from, to } as Filters;
};

const ids = (list?: string[]) =>
  (list ?? []).filter((i) => Types.ObjectId.isValid(i)).map((i) => new Types.ObjectId(i));

/** $match for appointments (the base of most charts) */
const appointmentMatch = (f: Filters): Record<string, unknown> => ({
  date: { $gte: f.from, $lte: f.to },
  isDeleted: { $ne: true },
  ...(f.doctorIds?.length && { doctor: { $in: ids(f.doctorIds) } }),
  ...(f.departmentIds?.length && { department: { $in: ids(f.departmentIds) } }),
  ...(f.sources?.length && { source: { $in: f.sources } }),
});

const dayStart = (date: string) => new Date(`${date}T00:00:00+06:00`);
const dayEnd = (date: string) => new Date(dayStart(date).getTime() + 24 * 3600 * 1000);
const dhakaDay = (field: string) => ({ $dateToString: { format: "%Y-%m-%d", date: field, timezone: "Asia/Dhaka" } });
const minutesBetween = (a: string, b: string) => ({ $divide: [{ $subtract: [b, a] }, 60000] });

/** Every date of the range, so charts show zero days instead of gaps */
export const datesOf = (f: Filters) =>
  Array.from({ length: daysBetween(f.from, f.to) + 1 }, (_, i) => addDays(f.from, i));

// ------------------------------------------------------------------ KPI cards

export const getKpis = async (date = todayInDhaka()) => {
  const f: Filters = { from: date, to: date };
  const [settings, apptFacets, collection, lab, vitals, board] = await Promise.all([
    getSettings(),
    AppointmentModel.aggregate([
      { $match: appointmentMatch(f) },
      {
        $facet: {
          byStatus: [{ $group: { _id: "$status", n: { $sum: 1 } } }],
          consult: [
            { $match: { consultationStartedAt: { $ne: null }, completedAt: { $ne: null } } },
            { $group: { _id: null, avg: { $avg: minutesBetween("$consultationStartedAt", "$completedAt") } } },
          ],
          wait: [
            { $match: { checkedInAt: { $ne: null }, consultationStartedAt: { $ne: null } } },
            { $group: { _id: null, avg: { $avg: minutesBetween("$checkedInAt", "$consultationStartedAt") } } },
          ],
          busiest: [
            { $match: { status: { $ne: "cancelled" } } },
            { $group: { _id: "$doctor", n: { $sum: 1 } } },
            { $sort: { n: -1 } },
            { $limit: 1 },
            { $lookup: { from: "doctors", localField: "_id", foreignField: "_id", as: "d" } },
            {
              $project: {
                n: 1,
                name: { $concat: [{ $ifNull: [{ $first: "$d.title" }, ""] }, " ", { $first: "$d.name" }] },
              },
            },
          ],
        },
      },
    ]),
    paymentMethods({ from: date, to: date }),
    LabOrderModel.aggregate([
      { $match: { createdAt: { $gte: dayStart(date), $lt: dayEnd(date) }, isDeleted: { $ne: true } } },
      {
        $group: {
          _id: null,
          ordered: { $sum: 1 },
          completed: { $sum: { $cond: [{ $in: ["$status", ["ready", "delivered"]] }, 1, 0] } },
          pending: {
            $sum: {
              $cond: [
                { $in: ["$status", ["ordered", "sample_collected", "processing", "awaiting_verification"]] },
                1,
                0,
              ],
            },
          },
          urgent: { $sum: { $cond: [{ $eq: ["$priority", "urgent"] }, 1, 0] } },
        },
      },
    ]),
    VitalsModel.aggregate([
      { $match: { recordedAt: { $gte: dayStart(date), $lt: dayEnd(date) } } },
      { $group: { _id: "$recordedBy", n: { $sum: 1 } } },
    ]),
    date === todayInDhaka() ? getTodayBoard() : Promise.resolve([]),
  ]);
  const abnormal = await abnormalFindings({ from: date, to: date });

  const s = apptFacets[0];
  const count = (st: string) => s.byStatus.find((r: any) => r._id === st)?.n ?? 0;
  const total = s.byStatus.reduce((a: number, r: any) => a + r.n, 0);
  const checkedIn = count("checked_in") + count("in_consultation") + count("completed");
  const target = settings.dailyCollectionTarget ?? 0;
  const collected = collection.total;

  return {
    date,
    appointments: {
      total,
      booked: count("booked"),
      checkedIn,
      completed: count("completed"),
      noShow: count("no_show"),
      cancelled: count("cancelled"),
      inConsultation: count("in_consultation"),
      noShowRate: total ? Math.round((count("no_show") / total) * 1000) / 10 : 0,
      avgConsultationMinutes: s.consult[0] ? Math.round(s.consult[0].avg) : null,
      avgWaitMinutes: s.wait[0] ? Math.round(s.wait[0].avg) : null,
    },
    collections: {
      today: collected,
      target,
      percentOfTarget: target ? Math.round((collected / target) * 100) : null,
      byMethod: collection.byMethod,
    },
    lab: {
      ordered: lab[0]?.ordered ?? 0,
      completed: lab[0]?.completed ?? 0,
      pending: lab[0]?.pending ?? 0,
      urgent: lab[0]?.urgent ?? 0,
      abnormalFindings: abnormal.total,
    },
    staff: {
      doctorsSittingToday: board.filter((d) => d.sitsToday).length,
      doctorsActiveNow: board.filter((d) => d.inSessionNow || d.currentSerial !== null).length,
      busiestDoctor: s.busiest[0] ? { name: String(s.busiest[0].name).trim(), patients: s.busiest[0].n } : null,
      nursesRecordingVitals: vitals.length,
      vitalsRecorded: vitals.reduce((a: number, r: any) => a + r.n, 0),
    },
    generatedAt: new Date().toISOString(),
  };
};

// ------------------------------------------------------------------ trends

/** Appointments per day by status (line chart) */
export const appointmentTrend = async (input: Partial<Filters>, statuses?: string[]) => {
  const f = normalizeRange(input);
  const rows = await AppointmentModel.aggregate([
    { $match: { ...appointmentMatch(f), ...(statuses?.length && { status: { $in: statuses } }) } },
    { $group: { _id: { date: "$date", status: "$status" }, n: { $sum: 1 } } },
  ]);
  const keys = ["completed", "no_show", "cancelled", "booked", "checked_in", "in_consultation"];
  return datesOf(f).map((date) => {
    const point: Record<string, number | string> = { date };
    for (const k of keys) point[k] = rows.find((r) => r._id.date === date && r._id.status === k)?.n ?? 0;
    return point;
  });
};

/** Billed revenue per day by line source (from non-void invoices; poisha) */
export const revenueTrend = async (input: Partial<Filters>, sources?: string[]) => {
  const f = normalizeRange(input);
  const rows = await InvoiceModel.aggregate([
    {
      $match: {
        date: { $gte: f.from, $lte: f.to },
        status: { $nin: ["draft", "void"] },
        ...(f.doctorIds?.length && { doctor: { $in: ids(f.doctorIds) } }),
        ...(f.departmentIds?.length && { department: { $in: ids(f.departmentIds) } }),
      },
    },
    { $unwind: "$items" },
    ...(sources?.length ? [{ $match: { "items.source": { $in: sources } } }] : []),
    { $group: { _id: { date: "$date", source: "$items.source" }, amount: { $sum: "$items.lineTotal" } } },
  ]);
  const keys = ["consultation", "lab_test", "medicine", "procedure", "other"];
  return datesOf(f).map((date) => {
    const point: Record<string, number | string> = { date };
    for (const k of keys) point[k] = rows.find((r) => r._id.date === date && r._id.source === k)?.amount ?? 0;
    point.total = keys.reduce((a, k) => a + (point[k] as number), 0);
    return point;
  });
};

// ------------------------------------------------------------------ doctors & departments

export const doctorStats = async (input: Partial<Filters>) => {
  const f = normalizeRange(input);
  const [rows, revenue] = await Promise.all([
    AppointmentModel.aggregate([
      { $match: appointmentMatch(f) },
      {
        $group: {
          _id: "$doctor",
          booked: { $sum: { $cond: [{ $ne: ["$status", "cancelled"] }, 1, 0] } },
          patientCount: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
          noShows: { $sum: { $cond: [{ $eq: ["$status", "no_show"] }, 1, 0] } },
          avgTime: {
            $avg: {
              $cond: [
                { $and: ["$consultationStartedAt", "$completedAt"] },
                minutesBetween("$consultationStartedAt", "$completedAt"),
                null,
              ],
            },
          },
          avgWait: {
            $avg: {
              $cond: [
                { $and: ["$checkedInAt", "$consultationStartedAt"] },
                minutesBetween("$checkedInAt", "$consultationStartedAt"),
                null,
              ],
            },
          },
        },
      },
      { $lookup: { from: "doctors", localField: "_id", foreignField: "_id", as: "d" } },
      { $lookup: { from: "departments", localField: "d.department", foreignField: "_id", as: "dep" } },
    ]),
    InvoiceModel.aggregate([
      { $match: { date: { $gte: f.from, $lte: f.to }, status: { $nin: ["draft", "void"] }, doctor: { $ne: null } } },
      { $group: { _id: "$doctor", revenue: { $sum: "$total" }, collected: { $sum: "$amountPaid" } } },
    ]),
  ]);
  return rows
    .map((r) => {
      const rev = revenue.find((x) => String(x._id) === String(r._id));
      return {
        doctorId: String(r._id),
        name: `${r.d[0]?.title ?? ""} ${r.d[0]?.name ?? "Unknown"}`.trim(),
        department: r.dep[0]?.name ?? "",
        booked: r.booked,
        patientCount: r.patientCount,
        noShows: r.noShows,
        avgTime: r.avgTime === null ? null : Math.round(r.avgTime),
        avgWait: r.avgWait === null ? null : Math.round(r.avgWait),
        revenue: rev?.revenue ?? 0,
        collected: rev?.collected ?? 0,
      };
    })
    .sort((a, b) => b.patientCount - a.patientCount);
};

export const departmentStats = async (input: Partial<Filters>) => {
  const f = normalizeRange(input);
  const rows = await AppointmentModel.aggregate([
    { $match: { ...appointmentMatch(f), status: { $ne: "cancelled" } } },
    {
      $group: {
        _id: "$department",
        visitsCount: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
        appointments: { $sum: 1 },
        avgWaitTime: {
          $avg: {
            $cond: [
              { $and: ["$checkedInAt", "$consultationStartedAt"] },
              minutesBetween("$checkedInAt", "$consultationStartedAt"),
              null,
            ],
          },
        },
      },
    },
    { $lookup: { from: "departments", localField: "_id", foreignField: "_id", as: "dep" } },
    { $sort: { appointments: -1 } },
  ]);
  return rows.map((r) => ({
    deptId: String(r._id),
    name: r.dep[0]?.name ?? "Unknown",
    nameBn: r.dep[0]?.nameBn ?? "",
    visitsCount: r.visitsCount,
    appointments: r.appointments,
    avgWaitTime: r.avgWaitTime === null ? null : Math.round(r.avgWaitTime),
  }));
};

/** Rows = doctors, columns = the last 7 days of the range, value = patients seen (completed) */
export const doctorHeatmap = async (input: Partial<Filters>) => {
  const f = normalizeRange(input);
  const days = Array.from({ length: 7 }, (_, i) => addDays(f.to, i - 6));
  const rows = await AppointmentModel.aggregate([
    { $match: { ...appointmentMatch({ ...f, from: days[0], to: f.to }), status: "completed" } },
    { $group: { _id: { doctor: "$doctor", date: "$date" }, n: { $sum: 1 } } },
    { $lookup: { from: "doctors", localField: "_id.doctor", foreignField: "_id", as: "d" } },
  ]);
  const doctors = new Map<string, { name: string; values: number[] }>();
  for (const r of rows) {
    const key = String(r._id.doctor);
    if (!doctors.has(key))
      doctors.set(key, { name: `${r.d[0]?.title ?? ""} ${r.d[0]?.name ?? ""}`.trim(), values: days.map(() => 0) });
    doctors.get(key)!.values[days.indexOf(r._id.date)] = r.n;
  }
  return {
    days,
    rows: [...doctors.entries()]
      .map(([doctorId, v]) => ({ doctorId, ...v }))
      .sort((a, b) => b.values.reduce((x, y) => x + y, 0) - a.values.reduce((x, y) => x + y, 0)),
  };
};

// ------------------------------------------------------------------ money, lab, booking behaviour, chat

/** Payments received in the range by method (refunds subtracted); poisha */
export const paymentMethods = async (input: Partial<Filters>) => {
  const f = normalizeRange(input);
  const range = { $gte: dayStart(f.from), $lt: dayEnd(f.to) };
  const [paid, refunded] = await Promise.all([
    InvoiceModel.aggregate([
      { $unwind: "$payments" },
      { $match: { "payments.at": range } },
      { $group: { _id: "$payments.method", amount: { $sum: "$payments.amount" }, count: { $sum: 1 } } },
    ]),
    InvoiceModel.aggregate([
      { $unwind: "$refunds" },
      { $match: { "refunds.at": range } },
      { $group: { _id: "$refunds.method", amount: { $sum: "$refunds.amount" } } },
    ]),
  ]);
  const byMethod = (["cash", "card", "bkash", "nagad"] as const).map((method) => ({
    method,
    amount: (paid.find((p) => p._id === method)?.amount ?? 0) - (refunded.find((r) => r._id === method)?.amount ?? 0),
    count: paid.find((p) => p._id === method)?.count ?? 0,
  }));
  return { total: byMethod.reduce((a, m) => a + m.amount, 0), byMethod };
};

/** Top 10 tests ordered in the range (optionally one catalogue category) */
export const labFrequency = async (input: Partial<Filters>) => {
  const f = normalizeRange(input);
  const pipeline: PipelineStage[] = [
    {
      $match: {
        createdAt: { $gte: dayStart(f.from), $lt: dayEnd(f.to) },
        isDeleted: { $ne: true },
        status: { $ne: "cancelled" },
      },
    },
    { $unwind: "$tests" },
  ];
  if (f.labCategory) {
    pipeline.push(
      { $lookup: { from: "labtests", localField: "tests.labTest", foreignField: "_id", as: "cat" } },
      { $match: { "cat.category": f.labCategory } },
    );
  }
  pipeline.push(
    {
      $group: {
        _id: "$tests.code",
        name: { $first: "$tests.name" },
        count: { $sum: 1 },
        abnormal: {
          $sum: {
            $cond: [
              {
                $gt: [
                  {
                    $size: {
                      $filter: {
                        input: "$tests.results",
                        as: "r",
                        cond: { $in: ["$$r.flag", ["low", "high", "abnormal", "critical"]] },
                      },
                    },
                  },
                  0,
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
    { $sort: { count: -1 } },
    { $limit: 10 },
  );
  const rows = await LabOrderModel.aggregate(pipeline);
  return rows.map((r) => ({ code: r._id, name: r.name, count: r.count, abnormal: r.abnormal }));
};

/** Verified results outside the normal range, by TEST NAME (never the values or the patient) */
export const abnormalFindings = async (input: Partial<Filters>) => {
  const f = normalizeRange(input);
  const rows = await LabOrderModel.aggregate([
    { $match: { verifiedAt: { $gte: dayStart(f.from), $lt: dayEnd(f.to) }, isDeleted: { $ne: true } } },
    { $unwind: "$tests" },
    { $unwind: "$tests.results" },
    { $match: { "tests.results.flag": { $in: ["low", "high", "abnormal", "critical"] } } },
    {
      $group: {
        _id: "$tests.name",
        count: { $sum: 1 },
        critical: { $sum: { $cond: [{ $eq: ["$tests.results.flag", "critical"] }, 1, 0] } },
      },
    },
    { $sort: { count: -1 } },
  ]);
  return {
    total: rows.reduce((a, r) => a + r.count, 0),
    critical: rows.reduce((a, r) => a + r.critical, 0),
    byTest: rows.map((r) => ({ test: r._id, count: r.count, critical: r.critical })),
  };
};

/** How many days ahead appointments were booked (histogram) */
export const leadTime = async (input: Partial<Filters>) => {
  const f = normalizeRange(input);
  const rows = await AppointmentModel.aggregate([
    { $match: appointmentMatch(f) },
    {
      $project: {
        lead: {
          $dateDiff: {
            startDate: { $dateFromString: { dateString: dhakaDay("$createdAt") } },
            endDate: { $dateFromString: { dateString: "$date" } },
            unit: "day",
          },
        },
      },
    },
    {
      $bucket: {
        groupBy: "$lead",
        boundaries: [-1000, 1, 2, 3, 8, 15, 10000],
        default: "other",
        output: { count: { $sum: 1 } },
      },
    },
  ]);
  const labels: Record<string, string> = {
    "-1000": "Same day",
    "1": "1 day",
    "2": "2 days",
    "3": "3–7 days",
    "8": "8–14 days",
    "15": "15+ days",
  };
  return Object.entries(labels).map(([key, label]) => ({
    bucket: label,
    count: rows.find((r) => String(r._id) === key)?.count ?? 0,
  }));
};

/** Patient messages per day by channel, and who answered (assistant vs staff) */
export const chatVolume = async (input: Partial<Filters>) => {
  const f = normalizeRange(input);
  const rows = await ChatMessageModel.aggregate([
    {
      $match: {
        createdAt: { $gte: dayStart(f.from), $lt: dayEnd(f.to) },
        sender: { $in: ["patient", "bot", "staff"] },
      },
    },
    { $group: { _id: { date: dhakaDay("$createdAt"), channel: "$channel", sender: "$sender" }, n: { $sum: 1 } } },
  ]);
  const sum = (date: string, pred: (r: any) => boolean) =>
    rows.filter((r) => r._id.date === date && pred(r)).reduce((a, r) => a + r.n, 0);
  return datesOf(f).map((date) => ({
    date,
    web: sum(date, (r) => r._id.sender === "patient" && r._id.channel === "web"),
    whatsapp: sum(date, (r) => r._id.sender === "patient" && r._id.channel === "whatsapp"),
    botReplies: sum(date, (r) => r._id.sender === "bot"),
    staffReplies: sum(date, (r) => r._id.sender === "staff"),
  }));
};

export const queueNow = async () => {
  const board = await getTodayBoard();
  return board.map((d) => ({
    doctorId: d.doctorId,
    doctor: d.displayName,
    department: d.department,
    roomNo: d.roomNo,
    inSession: d.inSessionNow,
    currentSerial: d.currentSerial,
    waiting: d.waiting,
    notArrived: d.notArrived,
    completed: d.completed,
  }));
};

export const analyticsService = {
  getKpis,
  appointmentTrend,
  revenueTrend,
  doctorStats,
  departmentStats,
  doctorHeatmap,
  paymentMethods,
  labFrequency,
  abnormalFindings,
  leadTime,
  chatVolume,
  queueNow,
};
