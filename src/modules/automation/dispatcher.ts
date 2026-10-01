/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomBytes } from "crypto";
import { hostname } from "os";
import { logger } from "../../utils/logger";
import type { OutboundMessage } from "../assistant/assistant.types";
import { adapterFor } from "../assistant/channels";
import "../assistant/channels/whatsapp/adapter"; // registers the WhatsApp adapter
import { ChatMessageModel } from "../assistant/chatMessage.model";
import { ConversationModel } from "../assistant/conversation.model";
import { getSettings } from "../hospital/settings/settings.service";
import { PatientModel } from "../patients/patient.model";
import { checkDuplicate, checkLimits, checkPreferences, checkQuietHours, GuardResult } from "./guards";
import { pushDecision, startRun } from "./jobs";
import { AutomationJobDocument, AutomationJobModel, DecisionReason } from "./models/job.model";
import { OutboxMessageDocument, OutboxMessageModel } from "./models/outbox.model";
import { sendToPatientPhone, sendToStaff } from "./outbox/outbox.service";
import { ruleContext } from "./rules/config";
import { getRule } from "./rules/registry";
import type { AnyRule, Prepared } from "./rules/types";
import { renderTemplate } from "./templates/render";
import { getTemplate } from "./templates/template.service";

/**
 * DISPATCHER — the only code that turns jobs into messages.
 *
 * Lease lock: a job is claimed with ONE atomic findOneAndUpdate (ready → sending + {workerId, until}).
 * If two server processes tick at the same moment, exactly one claim succeeds. A worker that crashes
 * mid-send leaves an expired lease, and the job is put back to "ready" on a later tick.
 *
 * For each claimed job: rule on? → rule.prepare() re-checks preconditions NOW (appointment still booked,
 * report still verified …) → preferences → quiet hours → limits → render → duplicate check → Outbox →
 * postSend. Every outcome is written to job.decisions with a reason.
 */

export const WORKER_ID = `${hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`;
export const LEASE_MS = 2 * 60_000;

/** Due scheduled jobs become ready; expired leases (crashed worker) are recovered */
export const promoteDue = async (now: Date) => {
  await AutomationJobModel.updateMany(
    { status: "sending", "lease.until": { $lt: now } },
    {
      $set: { status: "ready", lease: null },
      $push: { decisions: pushDecision("retried", "sendFailed", "Lease expired — worker stopped mid-send") },
    },
  );
  const res = await AutomationJobModel.updateMany(
    { status: "scheduled", scheduledFor: { $lte: now } },
    { $set: { status: "ready" } },
  );
  return res.modifiedCount;
};

/** Atomically claim one due job (or a specific one). null = nothing to do / someone else has it. */
export const claimJob = async (now: Date, workerId = WORKER_ID, jobId?: unknown) =>
  (await AutomationJobModel.findOneAndUpdate(
    {
      ...(jobId ? { _id: jobId, status: { $in: ["scheduled", "ready"] } } : { status: "ready" }),
      scheduledFor: { $lte: now },
    },
    { $set: { status: "sending", lease: { workerId, until: new Date(now.getTime() + LEASE_MS) } } },
    { sort: { urgent: -1, scheduledFor: 1 }, new: true },
  )) as AutomationJobDocument | null;

export type JobOutcome = "sent" | "failed" | "deferred" | "skipped" | "cancelled";

const finish = async (
  job: AutomationJobDocument,
  outcome: JobOutcome,
  reason: DecisionReason,
  detail?: string,
  extra: Record<string, unknown> = {},
): Promise<JobOutcome> => {
  const status = {
    sent: "sent",
    failed: "failed",
    deferred: "scheduled",
    skipped: "cancelled",
    cancelled: "cancelled",
  }[outcome];
  await AutomationJobModel.updateOne(
    { _id: job._id, "lease.workerId": job.lease?.workerId },
    {
      $set: {
        status,
        lease: null,
        ...(outcome === "skipped" || outcome === "cancelled" ? { cancelReason: detail ?? reason } : {}),
        ...extra,
      },
      $push: { decisions: pushDecision(outcome, reason, detail) },
      ...(outcome === "deferred" ? { $inc: { deferCount: 1 } } : {}),
    },
  );
  return outcome;
};

const fromGuard = (job: AutomationJobDocument, g: GuardResult) =>
  g.action === "defer"
    ? finish(job, "deferred", g.reason, g.detail, { scheduledFor: g.until })
    : g.action === "skip"
      ? finish(job, "skipped", g.reason, g.detail)
      : null;

/** Load + render the template in the right language */
const render = async (key: string, lang: "bn" | "en", variables: Record<string, unknown>, numerals: "bn" | "en") => {
  const tpl = await getTemplate(key);
  if (!tpl.isActive) throw new Error(`Template "${key}" is switched off`);
  const r = renderTemplate(tpl, lang, variables, numerals);
  if (r.missing.length) throw new Error(`Template "${key}" is missing ${r.missing.join(", ")}`);
  return { tpl, r };
};

const stringValues = (tplVars: { name: string }[], values: Record<string, unknown>) =>
  Object.fromEntries(tplVars.map((v) => [v.name, String(values[v.name] ?? "")]));

/** Process ONE claimed job. Never throws: failures are recorded on the job. */
export const processJob = async (job: AutomationJobDocument, now: Date): Promise<JobOutcome> => {
  const rule = getRule(job.ruleKey) as AnyRule | undefined;
  if (!rule) return finish(job, "cancelled", "preconditionFailed", `Unknown rule ${job.ruleKey}`);
  try {
    const ctx = await ruleContext(rule, now);
    if (ctx.settings.automationPaused)
      return finish(job, "deferred", "manual", "Automation is paused", {
        scheduledFor: new Date(now.getTime() + 15 * 60_000),
      });
    if (!ctx.enabled) return finish(job, "cancelled", "ruleDisabled", "Rule is switched off");

    const prepared: Prepared = await rule.prepare(job, ctx);
    if (!prepared.ok) return finish(job, "cancelled", "preconditionFailed", prepared.reason);
    const numerals = ctx.settings.messageNumerals;

    // ---- internal staff alert
    if (prepared.to === "staff") {
      const { tpl, r } = await render(prepared.templateKey ?? ctx.config.templateKey, "en", prepared.variables, "en");
      const outbox = await sendToStaff({
        permission: prepared.permission,
        text: r.text,
        loud: prepared.loud,
        ruleKey: rule.key,
        jobId: job._id,
        templateKey: tpl.key,
        templateVersion: tpl.version,
        variables: stringValues(tpl.variables, prepared.variables),
        related: prepared.related,
      });
      for (const phone of prepared.onCallPhones ?? [])
        await sendToPatientPhone({
          toType: "staff",
          phone,
          language: "en",
          text: r.text,
          buttons: [],
          template: {
            key: tpl.key,
            version: tpl.version,
            whatsappTemplateName: tpl.whatsappTemplateName,
            whatsappLanguage: tpl.whatsappLanguages.en,
            whatsappParams: tpl.whatsappParams,
          },
          variables: stringValues(tpl.variables, prepared.variables),
          channels: ["whatsapp"],
          source: "automation",
          ruleKey: rule.key,
          jobId: job._id,
          related: prepared.related,
        });
      return afterSend(job, rule, outbox, ctx, [{ channel: "inapp", result: "sent" }]);
    }

    // ---- patient (phone or open conversation): preferences first
    const patientId = prepared.patientId ?? null;
    const patient = patientId ? await PatientModel.findById(patientId).select("preferences").lean<any>() : null;
    const pref = checkPreferences(rule, patient?.preferences);
    if (pref.action !== "send") return fromGuard(job, pref)!;
    const quiet = checkQuietHours(now, ctx.settings, ctx.config, job.urgent);
    if (quiet.action !== "send") return fromGuard(job, quiet)!;
    const lang: "bn" | "en" = prepared.language ?? (patient?.preferences?.language === "en" ? "en" : "bn");

    if (prepared.to === "conversation") {
      const conv = await ConversationModel.findById(prepared.conversationId);
      if (!conv) return finish(job, "cancelled", "noRecipient", "Conversation no longer exists");
      const { tpl, r } = await render(
        prepared.templateKey ?? ctx.config.templateKey,
        lang,
        prepared.variables,
        numerals,
      );
      const message: OutboundMessage = { type: "text", text: r.text };
      const doc = await ChatMessageModel.create({
        conversation: conv._id,
        channel: conv.channel,
        direction: "outbound",
        sender: "automation",
        text: r.text,
        deliveryStatus: conv.channel === "whatsapp" ? "pending" : null,
      });
      await adapterFor(conv.channel).deliver(conv as any, [{ doc: doc as any, message }]);
      // The channel recorded the send in the Outbox; label that row as this rule's
      const outbox = (await OutboxMessageModel.findOneAndUpdate(
        { chatMessage: doc._id },
        {
          $set: {
            source: "automation",
            ruleKey: rule.key,
            job: job._id,
            templateKey: tpl.key,
            templateVersion: tpl.version,
            patient: patientId,
          },
        },
        { new: true },
      )) as OutboxMessageDocument | null;
      if (!outbox) return finish(job, "failed", "sendFailed", "Message was not recorded");
      return afterSend(job, rule, outbox, ctx, [
        { channel: outbox.channel, result: outbox.status === "failed" ? "failed" : "sent", error: outbox.error },
      ]);
    }

    // ---- patient phone: limits, render, duplicate check, send
    const limits = await checkLimits(now, rule, ctx.config, ctx.settings, prepared.phone);
    if (limits.action !== "send") return fromGuard(job, limits)!;
    const { tpl, r } = await render(prepared.templateKey ?? ctx.config.templateKey, lang, prepared.variables, numerals);
    const dup = await checkDuplicate(now, prepared.phone, r.text, ctx.settings);
    if (dup.action !== "send") return fromGuard(job, dup)!;

    const { outbox, attempts } = await sendToPatientPhone({
      patientId,
      phone: prepared.phone,
      language: lang,
      text: r.text,
      buttons: r.buttons.map((b) => ({ id: `auto|${b.action}|${prepared.buttonRef ?? job.scopeId}`, label: b.label })),
      template: {
        key: tpl.key,
        version: tpl.version,
        whatsappTemplateName: tpl.whatsappTemplateName,
        whatsappLanguage: tpl.whatsappLanguages[lang],
        whatsappParams: tpl.whatsappParams,
      },
      variables: stringValues(tpl.variables, prepared.variables),
      params: r.whatsappParams, // the approved template shows the same formatted dates and digits
      channels: ctx.config.channels,
      source: "automation",
      ruleKey: rule.key,
      jobId: job._id,
      related: prepared.related,
      scheduledFor: job.scheduledFor,
    });
    return afterSend(job, rule, outbox, ctx, attempts);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    logger.error({ err: message, jobId: String(job._id), rule: job.ruleKey }, "Automation job failed");
    await AutomationJobModel.updateOne({ _id: job._id }, { $set: { lastError: message.slice(0, 500) } });
    return finish(job, "failed", "sendFailed", message);
  }
};

const afterSend = async (
  job: AutomationJobDocument,
  rule: AnyRule,
  outbox: OutboxMessageDocument,
  ctx: Awaited<ReturnType<typeof ruleContext>>,
  attempts: { channel: string; result: "sent" | "failed"; error?: string | null }[],
): Promise<JobOutcome> => {
  const sent = outbox.status !== "failed";
  await AutomationJobModel.updateOne(
    { _id: job._id },
    { $push: { sendAttempts: { $each: attempts.map((a) => ({ ...a, at: new Date(), error: a.error ?? null })) } } },
  );
  if (!sent)
    return finish(job, "failed", "sendFailed", outbox.error ?? "Send failed", {
      outboxMessage: outbox._id,
      lastError: outbox.error ?? "Send failed",
    });
  const outcome = await finish(job, "sent", "sent", `${outbox.channel}${outbox.simulated ? " (simulated)" : ""}`, {
    outboxMessage: outbox._id,
    sentAt: new Date(),
    lastError: null,
  });
  if (rule.postSend)
    try {
      await rule.postSend(job, outbox, ctx);
    } catch (err) {
      logger.warn({ err: (err as Error).message, rule: rule.key }, "postSend step failed");
    }
  return outcome;
};

// ------------------------------------------------------------------ ticks

let running: Promise<unknown> | null = null;

/** One dispatcher tick: promote due jobs, then claim and process them one by one */
export const dispatchDue = async (now = new Date(), opts: { limit?: number; workerId?: string } = {}) => {
  const counts = { sent: 0, failed: 0, deferred: 0, skipped: 0, cancelled: 0 };
  const settings = await getSettings();
  if (settings.automationPaused) return counts;
  await promoteDue(now);
  for (let i = 0; i < (opts.limit ?? 200); i++) {
    const job = await claimJob(now, opts.workerId);
    if (!job) break;
    counts[await processJob(job, now)] += 1;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total) {
    const finishRun = await startRun("dispatcher", "dispatch", "cron");
    await finishRun({ scanned: total, ...counts, skipped: counts.skipped + counts.cancelled });
  }
  return counts;
};

/** Send an immediate job right away instead of waiting for the next minute (confirmations) */
export const dispatchNow = async (jobId: unknown, now = new Date()) => {
  const job = await claimJob(now, WORKER_ID, jobId);
  return job ? processJob(job, now) : null;
};

/** Serialised tick for the scheduler: a slow tick is never overlapped by the next one */
export const tick = async () => {
  if (running) return;
  running = dispatchDue().catch((err) => logger.error({ err: (err as Error).message }, "Dispatcher tick failed"));
  await running;
  running = null;
};

/** Graceful shutdown: give back every lease this process holds, so another worker can take the jobs */
export const releaseLeases = async (workerId = WORKER_ID) => {
  const res = await AutomationJobModel.updateMany(
    { status: "sending", "lease.workerId": workerId },
    { $set: { status: "ready", lease: null } },
  );
  return res.modifiedCount;
};

// ------------------------------------------------------------------ manual actions (admin)

/** A failed job goes back to the queue and is sent on the next tick (or right now) */
export const retryJob = async (jobId: unknown, opts: { now?: boolean } = {}) => {
  const job = await AutomationJobModel.findOneAndUpdate(
    { _id: jobId, status: "failed" },
    {
      $set: { status: "ready", scheduledFor: new Date(), lastError: null },
      $push: { decisions: pushDecision("retried", "manual", "Retried by an admin") },
    },
    { new: true },
  );
  if (!job) return null;
  return opts.now ? dispatchNow(job._id) : "ready";
};

/** Cancel a job that has not been sent yet */
export const cancelJob = async (jobId: unknown, reason = "Cancelled by an admin") => {
  const res = await AutomationJobModel.updateOne(
    { _id: jobId, status: { $in: ["draft", "scheduled", "ready"] } },
    {
      $set: { status: "cancelled", cancelReason: reason, lease: null },
      $push: { decisions: pushDecision("cancelled", "manual", reason) },
    },
  );
  return res.modifiedCount === 1;
};
