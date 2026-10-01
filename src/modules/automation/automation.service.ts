/* eslint-disable @typescript-eslint/no-explicit-any */
import { Request } from "express";
import { Types } from "mongoose";
import { roleHasPermission } from "../../config/permissions";
import AppError from "../../errors/AppError";
import { buildPagination } from "../../interface/global.interface";
import { escapeRegex } from "../../utils/escapeRegex";
import { recordAudit } from "../audit/audit.service";
import { isWhatsAppConfigured } from "../assistant/channels/whatsapp/client";
import { ChatMessageModel } from "../assistant/chatMessage.model";
import { ConversationModel } from "../assistant/conversation.model";
import { getSettings, HospitalSettings, updateSettings } from "../hospital/settings/settings.service";
import { PatientModel } from "../patients/patient.model";
import { cancelJob, retryJob } from "./dispatcher";
import { runPlanner } from "./engine";
import { checkPreferences, checkQuietHours } from "./guards";
import { AutomationJobModel, OPEN_JOB_STATUSES } from "./models/job.model";
import { OutboxMessageModel } from "./models/outbox.model";
import { AutomationRunModel } from "./models/run.model";
import { sendToPatientPhone } from "./outbox/outbox.service";
import { smsInfo } from "./outbox/sms";
import { ruleContext, ruleState } from "./rules/config";
import { allRules, getRule } from "./rules/registry";
import type { AnyRule } from "./rules/types";
import { schedulerStatus } from "./scheduler";
import { renderTemplate, sampleValues } from "./templates/render";
import { getTemplate } from "./templates/template.service";
import { addMinutes } from "./time";

/**
 * Read models and admin actions for the Automation page. Phones are masked everywhere here — the
 * page is for operations, not for looking people up.
 */

export const maskPhone = (p?: string | null) =>
  !p
    ? ""
    : p.startsWith("+880")
      ? `${p.slice(0, 6)}•••••${p.slice(-3)}`
      : p.startsWith("perm:")
        ? p
        : `${p.slice(0, 4)}•••`;

const DAY_MS = 24 * 60 * 60 * 1000;
const loadRule = (key: string) => {
  const rule = getRule(key);
  if (!rule) throw new AppError(404, "Automation rule not found.");
  return rule;
};

// ------------------------------------------------------------------ rules

const nextPlannerRun = (rule: AnyRule, now: Date) => {
  if (!rule.cadenceMinutes) return null;
  const minute = Math.floor(now.getTime() / 60_000);
  return new Date((Math.floor(minute / rule.cadenceMinutes) + 1) * rule.cadenceMinutes * 60_000);
};

export const listRules = async () => {
  const now = new Date();
  const since = new Date(now.getTime() - DAY_MS);
  const [counts, next, lastRuns] = await Promise.all([
    AutomationJobModel.aggregate([
      { $match: { updatedAt: { $gte: since } } },
      { $group: { _id: { rule: "$ruleKey", status: "$status" }, n: { $sum: 1 } } },
    ]),
    AutomationJobModel.aggregate([
      { $match: { status: { $in: OPEN_JOB_STATUSES } } },
      { $group: { _id: "$ruleKey", next: { $min: "$scheduledFor" }, open: { $sum: 1 } } },
    ]),
    AutomationRunModel.aggregate([
      { $sort: { startedAt: -1 } },
      { $group: { _id: "$ruleKey", run: { $first: "$$ROOT" } } },
    ]),
  ]);
  const count = (key: string, ...statuses: string[]) =>
    counts.filter((c) => c._id.rule === key && statuses.includes(c._id.status)).reduce((a, c) => a + c.n, 0);

  return Promise.all(
    allRules().map(async (rule) => {
      const state = await ruleState(rule);
      const n = next.find((x) => x._id === rule.key);
      const last = lastRuns.find((x) => x._id === rule.key)?.run;
      return {
        key: rule.key,
        title: rule.title,
        description: rule.description,
        trigger: rule.trigger,
        category: rule.category,
        essential: Boolean(rule.essential),
        cadenceMinutes: rule.cadenceMinutes ?? null,
        enabled: state.enabled,
        config: state.config,
        defaults: rule.defaults,
        nextSendAt: n?.next ?? null,
        openJobs: n?.open ?? 0,
        nextPlannerRun: state.enabled ? nextPlannerRun(rule, now) : null,
        lastRun: last
          ? { at: last.startedAt, kind: last.kind, ok: !(last.errors ?? []).length, errors: last.errors ?? [] }
          : null,
        last24h: {
          planned: count(rule.key, "scheduled", "ready", "sending", "sent", "failed", "cancelled", "superseded"),
          sent: count(rule.key, "sent"),
          cancelled: count(rule.key, "cancelled", "superseded"),
          failed: count(rule.key, "failed"),
        },
        updatedAt: state.updatedAt,
      };
    }),
  );
};

/** Run one planner right now (demo shortcut, or after changing a timing) */
export const runRuleNow = async (req: Request, key: string) => {
  const rule = loadRule(key);
  const result = await runPlanner(rule, new Date());
  await recordAudit({ req, action: "UPDATE", entityType: "AutomationRule", meta: { key, event: "run_now" } });
  return {
    created: result.created,
    updated: result.updated,
    planned: result.planned.length,
    skipped: result.skipped ?? null,
  };
};

/** "Test send to me": the rule's template with sample data, marked as a test, to the admin's phone */
export const testSend = async (req: Request, key: string, phone: string, language: "bn" | "en") => {
  const rule = loadRule(key);
  const { config, settings } = await ruleContext(rule, new Date());
  return sendTemplateTest(req, config.templateKey, phone, language, settings, config.channels);
};

const sendTemplateTest = async (
  req: Request,
  templateKey: string,
  phone: string,
  language: "bn" | "en",
  settings: HospitalSettings,
  channels: ("whatsapp" | "sms")[] = ["whatsapp", "sms"],
) => {
  const tpl = await getTemplate(templateKey);
  const r = renderTemplate(tpl, language, sampleValues(tpl.variables), settings.messageNumerals);
  const { outbox, attempts } = await sendToPatientPhone({
    phone,
    language,
    text: `[TEST] ${r.text}`,
    buttons: r.buttons.map((b) => ({ id: `test|${b.action}`, label: b.label })),
    template: {
      key: tpl.key,
      version: tpl.version,
      whatsappTemplateName: tpl.whatsappTemplateName,
      whatsappLanguage: tpl.whatsappLanguages[language],
      whatsappParams: tpl.whatsappParams,
    },
    params: r.whatsappParams,
    channels,
    source: "test",
    createdBy: req.user!.id,
  });
  await recordAudit({
    req,
    action: "CREATE",
    entityType: "OutboxMessage",
    entityId: outbox._id,
    meta: { test: templateKey },
  });
  return { outbox: outboxView(outbox.toObject()), attempts };
};

// ------------------------------------------------------------------ outbox

export const outboxView = (o: any) => ({
  id: String(o._id),
  createdAt: o.createdAt,
  sentAt: o.sentAt,
  scheduledFor: o.scheduledFor,
  status: o.status,
  channel: o.channel,
  source: o.source,
  messageKind: o.messageKind,
  ruleKey: o.ruleKey,
  templateKey: o.templateKey,
  templateVersion: o.templateVersion,
  whatsappTemplateName: o.whatsappTemplateName,
  toType: o.toType,
  to: maskPhone(o.toRef),
  patient: o.patient?._id
    ? { id: String(o.patient._id), name: o.patient.name, patientCode: o.patient.patientCode }
    : o.patient
      ? { id: String(o.patient) }
      : null,
  language: o.language,
  text: o.renderedText,
  buttons: (o.interactive?.buttons ?? []).map((b: any) => b.label),
  simulated: o.simulated,
  error: o.error,
  providerMessageId: o.providerMessageId,
  deliveryUpdates: o.deliveryUpdates ?? [],
  related: o.relatedType ? { type: o.relatedType, id: o.relatedId } : null,
  jobId: o.job ? String(o.job) : null,
  conversationId: o.conversation ? String(o.conversation) : null,
  replyAction: o.replyAction ?? null,
  repliedAt: o.repliedAt ?? null,
  retryOf: o.retryOf ? String(o.retryOf) : null,
});

export type OutboxFilters = {
  from?: string;
  to?: string;
  channel?: string;
  status?: string;
  ruleKey?: string;
  source?: string;
  patientId?: string;
  q?: string;
  page: number;
  limit: number;
};

const outboxQuery = (f: Omit<OutboxFilters, "page" | "limit">) => {
  const q: Record<string, any> = {};
  if (f.from || f.to)
    q.createdAt = {
      ...(f.from && { $gte: new Date(`${f.from}T00:00:00+06:00`) }),
      ...(f.to && { $lt: new Date(new Date(`${f.to}T00:00:00+06:00`).getTime() + DAY_MS) }),
    };
  if (f.channel) q.channel = f.channel;
  if (f.status) q.status = f.status;
  if (f.ruleKey) q.ruleKey = f.ruleKey;
  if (f.source) q.source = f.source;
  if (f.patientId) q.patient = new Types.ObjectId(f.patientId);
  if (f.q) q.renderedText = new RegExp(escapeRegex(f.q), "i");
  return q;
};

export const listOutbox = async (f: OutboxFilters) => {
  const q = outboxQuery(f);
  const [rows, total] = await Promise.all([
    OutboxMessageModel.find(q)
      .sort({ createdAt: -1 })
      .skip((f.page - 1) * f.limit)
      .limit(f.limit)
      .populate("patient", "name patientCode")
      .lean<any[]>(),
    OutboxMessageModel.countDocuments(q),
  ]);
  return { items: rows.map(outboxView), pagination: buildPagination(f.page, f.limit, total) };
};

export const getOutbox = async (id: string) => {
  const o = await OutboxMessageModel.findById(id).populate("patient", "name patientCode").lean<any>();
  if (!o) throw new AppError(404, "Message not found.");
  const job = o.job ? await AutomationJobModel.findById(o.job).lean<any>() : null;
  return { ...outboxView(o), job: job ? jobView(job) : null };
};

const csvCell = (v: unknown) => {
  const s = String(v ?? "").replace(/\r?\n/g, " ");
  // Quote always; neutralise spreadsheet formulas
  return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};

export const exportOutboxCsv = async (f: Omit<OutboxFilters, "page" | "limit">) => {
  const rows = await OutboxMessageModel.find(outboxQuery(f))
    .sort({ createdAt: -1 })
    .limit(5000)
    .populate("patient", "patientCode")
    .lean<any[]>();
  const header = [
    "createdAt",
    "status",
    "channel",
    "source",
    "rule",
    "template",
    "to",
    "patientCode",
    "language",
    "simulated",
    "error",
    "text",
  ];
  const lines = rows.map((o) =>
    [
      new Date(o.createdAt).toISOString(),
      o.status,
      o.channel,
      o.source,
      o.ruleKey ?? "",
      o.templateKey ?? "",
      maskPhone(o.toRef),
      o.patient?.patientCode ?? "",
      o.language,
      o.simulated ? "yes" : "no",
      o.error ?? "",
      o.renderedText,
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...lines].join("\r\n");
};

export const retryOutbox = async (req: Request, id: string) => {
  const o = await OutboxMessageModel.findById(id).lean<any>();
  if (!o) throw new AppError(404, "Message not found.");
  if (o.status !== "failed") throw new AppError(409, "Only failed messages can be retried.", "CONFLICT");
  if (!o.job) throw new AppError(409, "Only automated messages can be retried here.", "CONFLICT");
  const result = await retryJob(o.job, { now: true });
  if (!result) throw new AppError(409, "This message's job is not in a failed state any more.", "CONFLICT");
  await recordAudit({
    req,
    action: "UPDATE",
    entityType: "OutboxMessage",
    entityId: id,
    meta: { event: "retry", result },
  });
  return { result };
};

export const cancelOutbox = async (req: Request, id: string) => {
  const o = await OutboxMessageModel.findById(id);
  if (!o) throw new AppError(404, "Message not found.");
  if (o.status !== "queued") throw new AppError(409, "Only queued messages can be cancelled.", "CONFLICT");
  o.status = "cancelled";
  o.deliveryUpdates.push({ status: "cancelled", at: new Date() });
  await o.save();
  await recordAudit({ req, action: "UPDATE", entityType: "OutboxMessage", entityId: id, meta: { event: "cancel" } });
  return outboxView(o.toObject());
};

/** Admin: send the same text to their own phone, clearly marked as a test */
export const duplicateAsTest = async (req: Request, id: string, phone: string) => {
  const o = await OutboxMessageModel.findById(id).lean<any>();
  if (!o) throw new AppError(404, "Message not found.");
  if (o.channel === "inapp" || !o.renderedText)
    throw new AppError(409, "Only patient messages can be duplicated.", "CONFLICT");
  const { outbox, attempts } = await sendToPatientPhone({
    phone,
    language: o.language,
    text: `[TEST] ${o.renderedText}`,
    buttons: (o.interactive?.buttons ?? []).map((b: any) => ({
      id: `test|${String(b.id).split("|")[1] ?? "x"}`,
      label: b.label,
    })),
    channels: [o.channel === "sms" ? "sms" : "whatsapp"],
    source: "test",
    createdBy: req.user!.id,
    retryOf: o._id,
  });
  await recordAudit({
    req,
    action: "CREATE",
    entityType: "OutboxMessage",
    entityId: outbox._id,
    meta: { duplicateOf: id },
  });
  return { outbox: outboxView(outbox.toObject()), attempts };
};

// ------------------------------------------------------------------ jobs / queue / runs

export const jobView = (j: any) => ({
  id: String(j._id),
  ruleKey: j.ruleKey,
  title: getRule(j.ruleKey)?.title ?? j.ruleKey,
  dedupeKey: j.dedupeKey,
  scope: { type: j.scopeType, id: j.scopeId },
  patient: j.patient?._id
    ? { id: String(j.patient._id), name: j.patient.name, patientCode: j.patient.patientCode }
    : null,
  scheduledFor: j.scheduledFor,
  originalScheduledFor: j.originalScheduledFor,
  status: j.status,
  urgent: j.urgent,
  deferCount: j.deferCount,
  cancelReason: j.cancelReason,
  lastError: j.lastError,
  sentAt: j.sentAt,
  decisions: j.decisions ?? [],
  sendAttempts: j.sendAttempts ?? [],
  supersededBy: j.supersededBy ? String(j.supersededBy) : null,
  outboxMessageId: j.outboxMessage ? String(j.outboxMessage) : null,
  createdAt: j.createdAt,
});

/** Jobs due in the next N minutes (and overdue ones still waiting), for the Scheduled Queue tab */
export const upcomingQueue = async (minutes: number) => {
  const until = addMinutes(new Date(), minutes);
  const jobs = await AutomationJobModel.find({
    status: { $in: [...OPEN_JOB_STATUSES, "sending"] },
    scheduledFor: { $lte: until },
  })
    .sort({ scheduledFor: 1 })
    .limit(500)
    .populate("patient", "name patientCode")
    .lean<any[]>();
  return jobs.map(jobView);
};

export const listJobs = async (f: {
  ruleKey?: string;
  status?: string;
  from?: string;
  to?: string;
  page: number;
  limit: number;
}) => {
  const q: Record<string, any> = {};
  if (f.ruleKey) q.ruleKey = f.ruleKey;
  if (f.status) q.status = f.status;
  if (f.from || f.to)
    q.updatedAt = { ...(f.from && { $gte: new Date(f.from) }), ...(f.to && { $lte: new Date(f.to) }) };
  const [rows, total] = await Promise.all([
    AutomationJobModel.find(q)
      .sort({ updatedAt: -1 })
      .skip((f.page - 1) * f.limit)
      .limit(f.limit)
      .populate("patient", "name patientCode")
      .lean<any[]>(),
    AutomationJobModel.countDocuments(q),
  ]);
  return { items: rows.map(jobView), pagination: buildPagination(f.page, f.limit, total) };
};

export const getJob = async (id: string) => {
  const j = await AutomationJobModel.findById(id).populate("patient", "name patientCode").lean<any>();
  if (!j) throw new AppError(404, "Job not found.");
  return jobView(j);
};

export const cancelJobAction = async (req: Request, id: string, reason?: string) => {
  if (!(await cancelJob(id, reason || `Cancelled by ${req.user!.name}`)))
    throw new AppError(409, "Only jobs that have not been sent yet can be cancelled.", "CONFLICT");
  await recordAudit({ req, action: "UPDATE", entityType: "AutomationJob", entityId: id, meta: { event: "cancel" } });
  return getJob(id);
};

export const retryJobAction = async (req: Request, id: string) => {
  const result = await retryJob(id, { now: true });
  if (!result) throw new AppError(409, "Only failed jobs can be retried.", "CONFLICT");
  await recordAudit({
    req,
    action: "UPDATE",
    entityType: "AutomationJob",
    entityId: id,
    meta: { event: "retry", result },
  });
  return getJob(id);
};

export const listRuns = async (f: {
  ruleKey?: string;
  kind?: string;
  withErrors?: boolean;
  page: number;
  limit: number;
}) => {
  const q: Record<string, any> = {};
  if (f.ruleKey) q.ruleKey = f.ruleKey;
  if (f.kind) q.kind = f.kind;
  if (f.withErrors) q.$or = [{ "errors.0": { $exists: true } }, { failed: { $gt: 0 } }];
  const [rows, total] = await Promise.all([
    AutomationRunModel.find(q)
      .sort({ startedAt: -1 })
      .skip((f.page - 1) * f.limit)
      .limit(f.limit)
      .lean<any[]>(),
    AutomationRunModel.countDocuments(q),
  ]);
  return {
    items: rows.map((r) => ({
      id: String(r._id),
      ruleKey: r.ruleKey,
      title: getRule(r.ruleKey)?.title ?? (r.ruleKey === "dispatcher" ? "Dispatcher" : r.ruleKey),
      kind: r.kind,
      trigger: r.trigger,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      durationMs: r.finishedAt ? new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime() : null,
      scanned: r.scanned,
      created: r.created,
      cancelled: r.cancelled,
      sent: r.sent,
      deferred: r.deferred,
      skipped: r.skipped,
      failed: r.failed,
      errors: r.errors ?? [],
      dryRun: r.dryRun,
    })),
    pagination: buildPagination(f.page, f.limit, total),
  };
};

// ------------------------------------------------------------------ health + settings

export const health = async () => {
  const now = new Date();
  const hourAgo = addMinutes(now, -60);
  const [settings, failedLastHour, queueDepth, nextHour, overdue] = await Promise.all([
    getSettings(),
    OutboxMessageModel.countDocuments({ status: "failed", createdAt: { $gte: hourAgo } }),
    AutomationJobModel.countDocuments({ status: { $in: OPEN_JOB_STATUSES } }),
    AutomationJobModel.countDocuments({
      status: { $in: OPEN_JOB_STATUSES },
      scheduledFor: { $lte: addMinutes(now, 60) },
    }),
    AutomationJobModel.countDocuments({
      status: { $in: OPEN_JOB_STATUSES },
      scheduledFor: { $lte: addMinutes(now, -5) },
    }),
  ]);
  return {
    scheduler: schedulerStatus,
    paused: settings.automationPaused,
    simulation: { whatsapp: settings.simulateWhatsApp, sms: settings.simulateSms },
    whatsappConfigured: isWhatsAppConfigured(),
    sms: { ...smsInfo(), fallbackEnabled: settings.smsFallbackEnabled },
    failedLastHour,
    failureAlertThreshold: settings.failureAlertThreshold,
    queueDepth,
    nextHour,
    overdue, // due more than 5 minutes ago and still waiting → the scheduler is not running
    rules: (await listRules()).map((r) => ({
      key: r.key,
      title: r.title,
      enabled: r.enabled,
      lastRun: r.lastRun,
      failed24h: r.last24h.failed,
    })),
  };
};

export const AUTOMATION_SETTING_KEYS = [
  "automationPaused",
  "quietHoursStart",
  "quietHoursEnd",
  "messageNumerals",
  "automationDailyBudget",
  "perPhoneDailyCap",
  "dedupeWindowMinutes",
  "simulateWhatsApp",
  "simulateSms",
  "whatsappLiveRecipients",
  "smsFallbackEnabled",
  "failureAlertThreshold",
] as const;
type AutomationSettingKey = (typeof AUTOMATION_SETTING_KEYS)[number];

const pickSettings = (s: HospitalSettings) =>
  Object.fromEntries(AUTOMATION_SETTING_KEYS.map((k) => [k, s[k]])) as Pick<HospitalSettings, AutomationSettingKey>;

export const getAutomationSettings = async () => ({
  ...pickSettings(await getSettings()),
  whatsappConfigured: isWhatsAppConfigured(),
  sms: smsInfo(),
});

export const updateAutomationSettings = async (
  req: Request,
  input: Partial<Pick<HospitalSettings, AutomationSettingKey>>,
) => {
  await updateSettings(req, input);
  return getAutomationSettings();
};

// ------------------------------------------------------------------ preview world

/**
 * "What would happen between now and <at>?" — planners run in DRY-RUN mode at that moment, plus the
 * jobs already queued; each candidate is prepared and checked against preferences and quiet hours, and
 * its text rendered. Nothing is stored or sent (prepare() only reads).
 */
export const previewWorld = async (at: Date) => {
  const now = new Date();
  const candidates: { rule: AnyRule; job: any; planned: boolean }[] = [];
  const queued = await AutomationJobModel.find({ status: { $in: OPEN_JOB_STATUSES }, scheduledFor: { $lte: at } })
    .sort({ scheduledFor: 1 })
    .limit(300);
  for (const job of queued) {
    const rule = getRule(job.ruleKey);
    if (rule) candidates.push({ rule, job, planned: false });
  }
  const known = new Set(queued.map((j) => `${j.ruleKey}|${j.dedupeKey}`));
  for (const rule of allRules()) {
    if (!rule.plan) continue;
    // Planners run every hour (or more often) — replay them hourly from now to the chosen moment
    const planned = [];
    for (let t = now.getTime(); ; t = Math.min(t + 3600e3, at.getTime())) {
      planned.push(...(await runPlanner(rule, new Date(t), { dryRun: true })).planned);
      if (t >= at.getTime()) break;
    }
    for (const p of planned) {
      if (known.has(`${rule.key}|${p.dedupeKey}`) || p.scheduledFor > at) continue;
      known.add(`${rule.key}|${p.dedupeKey}`);
      const exists = await AutomationJobModel.exists({ ruleKey: rule.key, dedupeKey: p.dedupeKey });
      if (exists) continue;
      const job = new AutomationJobModel({
        ruleKey: rule.key,
        ...p,
        patient: p.patientId ?? null,
        originalScheduledFor: p.scheduledFor,
        status: "draft",
        urgent: Boolean(p.urgent),
        data: p.data ?? {},
      });
      candidates.push({ rule, job, planned: true });
    }
  }

  const out = [];
  for (const { rule, job, planned } of candidates.slice(0, 300)) {
    const when = job.scheduledFor < now ? now : job.scheduledFor;
    const ctx = await ruleContext(rule, when);
    let decision = ctx.enabled ? "send" : "rule disabled";
    let to = "";
    let text = "";
    let patient: any = null;
    try {
      const prepared = await rule.prepare(job, ctx);
      if (!prepared.ok) decision = `cancel: ${prepared.reason}`;
      else {
        const tplKey = prepared.templateKey ?? ctx.config.templateKey;
        const tpl = await getTemplate(tplKey);
        if (prepared.to === "staff") to = `staff (${prepared.permission})`;
        else {
          const pid = prepared.patientId ?? null;
          patient = pid ? await PatientModel.findById(pid).select("name patientCode preferences").lean<any>() : null;
          to = prepared.to === "patient" ? maskPhone(prepared.phone) : "open chat";
          const pref = checkPreferences(rule, patient?.preferences);
          const quiet = checkQuietHours(when, ctx.settings, ctx.config, job.urgent);
          if (decision === "send" && pref.action !== "send")
            decision = `skip: ${pref.action === "skip" ? pref.detail : ""}`;
          else if (decision === "send" && quiet.action === "defer") decision = `defer: ${quiet.detail}`;
        }
        const lang =
          prepared.to === "staff"
            ? "en"
            : (prepared.language ?? (patient?.preferences?.language === "en" ? "en" : "bn"));
        text = renderTemplate(
          tpl,
          lang,
          prepared.variables,
          prepared.to === "staff" ? "en" : ctx.settings.messageNumerals,
        ).text;
      }
    } catch (err) {
      decision = `error: ${(err as Error).message}`;
    }
    out.push({
      ruleKey: rule.key,
      title: rule.title,
      scheduledFor: job.scheduledFor,
      alreadyQueued: !planned,
      to,
      patient: patient ? { id: String(patient._id), name: patient.name, patientCode: patient.patientCode } : null,
      decision,
      text,
    });
  }
  return out.sort((a, b) => new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime());
};

// ------------------------------------------------------------------ patient "Messages" tab

/** Every message to (and, for inbox staff, from) this patient's phone, newest first */
export const patientMessages = async (req: Request, patientId: string) => {
  const p = await PatientModel.findById(patientId).select("phone preferences name").lean<any>();
  if (!p) throw new AppError(404, "Patient not found.");
  const canSeeChats = roleHasPermission(req.user!.role, "inbox:manage");
  const outbox = await OutboxMessageModel.find({ $or: [{ patient: p._id }, { toRef: p.phone }] })
    .sort({ createdAt: -1 })
    .limit(200)
    .lean<any[]>();
  const items: any[] = outbox.map((o) => ({ kind: "outbox", direction: "outbound", ...outboxView(o) }));
  if (canSeeChats) {
    const convs = await ConversationModel.find({ verifiedPhone: p.phone }).select("_id channel").lean<any[]>();
    const inbound = await ChatMessageModel.find({
      conversation: { $in: convs.map((c) => c._id) },
      direction: "inbound",
    })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean<any[]>();
    for (const m of inbound)
      items.push({
        kind: "chat",
        direction: "inbound",
        id: String(m._id),
        createdAt: m.createdAt,
        channel: m.channel,
        text: m.text,
        conversationId: String(m.conversation),
      });
  }
  items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  await recordAudit({ req, action: "VIEW", entityType: "PatientMessages", entityId: p._id });
  return { preferences: p.preferences, items: items.slice(0, 300), includesChats: canSeeChats };
};
