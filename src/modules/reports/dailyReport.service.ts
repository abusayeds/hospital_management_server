/* eslint-disable @typescript-eslint/no-explicit-any */
import { Request } from "express";
import { generateStructured, isAiConfigured } from "../../ai/ai.service";
import { scrubText } from "../../ai/deidentify";
import { dailyReportPrompt, dailyReportSchema } from "../../ai/prompts/daily-report.v1";
import AppError from "../../errors/AppError";
import { publish } from "../../events/bus";
import { buildPagination } from "../../interface/global.interface";
import { emitToPermission } from "../../sockets/index";
import { addDays, DAY_NAMES_EN, todayInDhaka, weekdayOf } from "../../utils/date";
import { logger } from "../../utils/logger";
import {
  abnormalFindings,
  appointmentTrend,
  chatVolume,
  departmentStats,
  doctorStats,
  getKpis,
  labFrequency,
  paymentMethods,
  revenueTrend,
} from "../analytics/analytics.service";
import { recordAudit } from "../audit/audit.service";
import { AppointmentModel } from "../hospital/appointment/appointment.model";
import { OperationalReportModel } from "./operationalReport.model";

/**
 * AI DAILY REPORT — end-of-day narrative for management.
 *
 *   collectDailyStats(date)  aggregated numbers only (counts, money, department/doctor/test NAMES) —
 *                            never a patient name, phone, code, diagnosis or result value
 *   generateDailyReport()    asks the AI for a 5–8 sentence Bangla narrative; if the AI is not configured,
 *                            fails, or its text fails the privacy check, the rule-based bullet summary is used
 *   one report per date (regenerating replaces it); delivery is the `daily_ai_report` automation rule
 */

const taka = (poisha: number) => `৳${Math.round(poisha / 100).toLocaleString("en-IN")}`;
const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);

export type DailyStats = Awaited<ReturnType<typeof collectDailyStats>>;

export const collectDailyStats = async (date: string) => {
  const day = { from: date, to: date };
  const lastWeek = addDays(date, -7);
  const [kpis, trend, prevPayments, revenue, depts, doctors, lab, abnormal, chat, channels] = await Promise.all([
    getKpis(date),
    appointmentTrend({ from: lastWeek, to: date }),
    paymentMethods({ from: addDays(date, -1), to: addDays(date, -1) }),
    revenueTrend(day),
    departmentStats(day),
    doctorStats(day),
    labFrequency(day),
    abnormalFindings(day),
    chatVolume(day),
    AppointmentModel.aggregate([
      { $match: { date, isDeleted: { $ne: true } } },
      { $group: { _id: "$source", n: { $sum: 1 } } },
    ]),
  ]);
  const totalOf = (d: string) => {
    const row = trend.find((r) => r.date === d);
    if (!row) return { total: 0, completed: 0 };
    const total = ["completed", "no_show", "cancelled", "booked", "checked_in", "in_consultation"].reduce(
      (a, k) => a + Number(row[k] ?? 0),
      0,
    );
    return { total, completed: Number(row.completed ?? 0) };
  };
  const a = kpis.appointments;
  const busiest = doctors[0];
  return {
    date,
    weekday: DAY_NAMES_EN[weekdayOf(date)],
    appointments: {
      total: a.total,
      completed: a.completed,
      noShow: a.noShow,
      cancelled: a.cancelled,
      noShowRatePct: a.noShowRate,
      avgWaitMinutes: a.avgWaitMinutes,
      avgConsultationMinutes: a.avgConsultationMinutes,
      previousDay: totalOf(addDays(date, -1)),
      sameWeekdayLastWeek: totalOf(lastWeek),
      byChannel: Object.fromEntries(channels.map((c: any) => [c._id, c.n])),
    },
    money: {
      collectedPoisha: kpis.collections.today,
      targetPoisha: kpis.collections.target,
      percentOfTarget: kpis.collections.percentOfTarget,
      byMethodPoisha: Object.fromEntries(kpis.collections.byMethod.map((m) => [m.method, m.amount])),
      previousDayCollectedPoisha: prevPayments.total,
      billedPoisha: Number(revenue[0]?.total ?? 0),
    },
    departments: depts
      .slice(0, 5)
      .map((d) => ({ name: d.name, completedVisits: d.visitsCount, avgWaitMinutes: d.avgWaitTime })),
    busiestDoctor: busiest && busiest.patientCount ? { name: busiest.name, patientsSeen: busiest.patientCount } : null,
    lab: {
      ordered: kpis.lab.ordered,
      completed: kpis.lab.completed,
      pending: kpis.lab.pending,
      urgent: kpis.lab.urgent,
      abnormalResults: abnormal.total,
      criticalResults: abnormal.critical,
      topTests: lab.slice(0, 5).map((t) => ({ name: t.name, count: t.count })),
    },
    messages: chat[0]
      ? {
          web: chat[0].web,
          whatsapp: chat[0].whatsapp,
          assistantReplies: chat[0].botReplies,
          staffReplies: chat[0].staffReplies,
        }
      : null,
    vitalsRecorded: kpis.staff.vitalsRecorded,
  };
};

/** Plain Bangla KPI lines — shown under every report and used alone when the AI is unavailable */
export const fallbackBullets = (s: DailyStats): string[] => {
  const a = s.appointments;
  const lines = [
    `অ্যাপয়েন্টমেন্ট: মোট ${a.total}টি — সম্পন্ন ${a.completed}, অনুপস্থিত ${a.noShow} (${a.noShowRatePct}%), বাতিল ${a.cancelled}`,
    `তুলনা: আগের দিন ${a.previousDay.total}টি, গত সপ্তাহের একই দিনে ${a.sameWeekdayLastWeek.total}টি`,
    `সংগ্রহ: ${taka(s.money.collectedPoisha)}${s.money.percentOfTarget !== null ? ` (লক্ষ্যের ${s.money.percentOfTarget}%)` : ""} · আগের দিন ${taka(s.money.previousDayCollectedPoisha)}`,
    `ল্যাব: ${s.lab.ordered}টি অর্ডার, ${s.lab.completed}টি রিপোর্ট প্রস্তুত, ${s.lab.pending}টি অপেক্ষমাণ · স্বাভাবিকের বাইরে ফলাফল ${s.lab.abnormalResults}টি`,
  ];
  if (a.avgWaitMinutes !== null)
    lines.push(
      `গড় অপেক্ষা ${a.avgWaitMinutes} মিনিট${a.avgConsultationMinutes !== null ? `, গড় পরামর্শ ${a.avgConsultationMinutes} মিনিট` : ""}`,
    );
  if (s.departments[0])
    lines.push(`সবচেয়ে ব্যস্ত বিভাগ: ${s.departments[0].name} (${s.departments[0].completedVisits} জন)`);
  if (s.busiestDoctor)
    lines.push(`সবচেয়ে বেশি রোগী দেখেছেন: ${s.busiestDoctor.name} (${s.busiestDoctor.patientsSeen} জন)`);
  if (s.messages)
    lines.push(
      `রোগীর মেসেজ: ওয়েব ${s.messages.web}, হোয়াটসঅ্যাপ ${s.messages.whatsapp} · স্টাফের উত্তর ${s.messages.staffReplies}`,
    );
  return lines;
};

const fallbackNarrative = (date: string, bullets: string[]) =>
  `${date} তারিখের স্বয়ংক্রিয় সারাংশ (AI ছাড়া তৈরি):\n${bullets.map((b) => `• ${b}`).join("\n")}`;

/** Belt and braces: the AI text must not contain anything that looks like a phone, email, NID or patient code */
const passesPrivacyCheck = (text: string) => scrubText(text) === text;

const toView = (doc: any) => ({
  id: String(doc._id),
  date: doc.date,
  source: doc.source,
  narrative: doc.narrative,
  highlights: doc.highlights ?? [],
  bullets: doc.bullets ?? [],
  stats: doc.stats ?? {},
  model: doc.model,
  promptVersion: doc.promptVersion,
  fallbackReason: doc.fallbackReason,
  generatedAt: doc.generatedAt,
  generatedBy: doc.generatedBy ? String(doc.generatedBy) : null,
  deliveredAt: doc.deliveredAt,
  deliveryCount: doc.deliveryCount ?? 0,
});
export type ReportView = ReturnType<typeof toView>;

export const generateDailyReport = async (
  date: string,
  opts: { req?: Request; reuse?: boolean } = {},
): Promise<ReportView> => {
  if (date > todayInDhaka())
    throw new AppError(400, "A report can only be made for today or an earlier day.", "VALIDATION_ERROR");
  if (opts.reuse) {
    const existing = await OperationalReportModel.findOne({ date }).lean();
    if (existing) return toView(existing);
  }

  const stats = await collectDailyStats(date);
  const bullets = fallbackBullets(stats);
  let content: {
    source: "ai" | "fallback";
    narrative: string;
    highlights: string[];
    model: string | null;
    promptVersion: string | null;
    fallbackReason: string | null;
  } = {
    source: "fallback",
    narrative: fallbackNarrative(date, bullets),
    highlights: [],
    model: null,
    promptVersion: null,
    fallbackReason: "AI is not configured on this server",
  };
  if (isAiConfigured()) {
    try {
      const r = await generateStructured({
        prompt: dailyReportPrompt,
        input: stats,
        schema: dailyReportSchema,
        userId: opts.req?.user?.id,
        entityId: `report:${date}`,
      });
      const text = [r.data.narrative, ...r.data.highlights].join("\n");
      if (passesPrivacyCheck(text))
        content = {
          source: "ai",
          narrative: r.data.narrative,
          highlights: r.data.highlights,
          model: r.model,
          promptVersion: r.promptVersion,
          fallbackReason: null,
        };
      else content.fallbackReason = "The AI text failed the privacy check";
    } catch (err) {
      content.fallbackReason = err instanceof AppError ? err.message : "The AI request failed";
      logger.warn({ err, date }, "Daily report: AI failed, using the fallback summary");
    }
  }

  const doc = await OperationalReportModel.findOneAndUpdate(
    { date },
    { $set: { ...content, bullets, stats, generatedAt: new Date(), generatedBy: opts.req?.user?.id ?? null } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  const view = toView(doc);

  await recordAudit({
    req: opts.req,
    action: "CREATE",
    entityType: "OperationalReport",
    entityId: view.id,
    meta: { date, source: view.source },
  });
  void publish("report.daily_generated", { reportId: view.id, date, source: view.source });
  emitToPermission("report:operations", "reports:updated", { date });
  return view;
};

export const markDelivered = (date: string) =>
  OperationalReportModel.updateOne({ date }, { $set: { deliveredAt: new Date() }, $inc: { deliveryCount: 1 } });

export const listReports = async (page = 1, limit = 20) => {
  const [items, total] = await Promise.all([
    OperationalReportModel.find()
      .sort({ date: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    OperationalReportModel.countDocuments(),
  ]);
  return { items: items.map(toView), pagination: buildPagination(page, limit, total) };
};

export const getReport = async (date: string) => {
  const doc = await OperationalReportModel.findOne({ date }).lean();
  if (!doc) throw new AppError(404, "No report for this date yet.");
  return toView(doc);
};

/** First sentence of the narrative, for the short in-app / WhatsApp notice */
export const headlineOf = (r: ReportView) => {
  const first = r.source === "ai" ? r.narrative.split(/(?<=[।.!?])\s/)[0] : (r.bullets[0] ?? r.narrative);
  return first.length > 180 ? `${first.slice(0, 177)}…` : first;
};
