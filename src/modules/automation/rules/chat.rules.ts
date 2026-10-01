/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from "zod";
import { emitToPermission } from "../../../sockets";
import { ConversationModel } from "../../assistant/conversation.model";
import { addMinutes } from "../time";
import { registerRule } from "./registry";
import { fail, hospitalPhone } from "./shared";
import type { PlannedJob, RuleDefinition } from "./types";

/**
 * 8. CHAT "NO REPLY" FOLLOW-UP — nobody is left waiting in the inbox.
 *   staff  : a conversation needs a human and no staff replied within N minutes → inbox alert
 *   patient: still no reply after a longer time → a courteous "we are getting back to you"
 *   idle   : a TAKEN-OVER chat where the patient wrote again and staff did not answer within the
 *            hospital's take-over reminder minutes → inbox alert (replaces the Phase 5 timer)
 * Dedupe keys include the moment the wait started, so each new wait gets at most one alert.
 */

type ChatConfig = { staffAlertMinutes: number; patientMessageMinutes: number };

const CHANNEL_LABEL: Record<string, string> = { whatsapp: "WhatsApp", web: "Web chat" };
const WINDOW_MS = 24 * 60 * 60 * 1000;

/** No staff answer since the wait started */
const unanswered = (since: Date | null | undefined, c: any) =>
  Boolean(since) && !(c.lastStaffReplyAt && new Date(c.lastStaffReplyAt) >= new Date(since!));

export const chatNoReply = registerRule({
  key: "chat_no_reply",
  title: "Chat no-reply follow-up",
  description:
    "Conversations waiting for a person: an inbox alert after N minutes (default 20), a courteous message to the patient after a longer wait, and a reminder when a taken-over chat goes quiet.",
  trigger: "every minute",
  category: "internal",
  enabledByDefault: true,
  cadenceMinutes: 1,
  defaults: {
    staffAlertMinutes: 20,
    patientMessageMinutes: 45,
    quietHoursOverride: true,
    dailyLimit: 1000,
    channels: ["whatsapp"],
    templateKey: "chat_waiting_staff",
  },
  configSchema: z
    .object({
      staffAlertMinutes: z.number().int().min(1).max(240),
      patientMessageMinutes: z
        .number()
        .int()
        .min(5)
        .max(24 * 60),
    })
    .partial(),
  async plan({ now, config, settings }) {
    const jobs: PlannedJob[] = [];
    const waiting = await ConversationModel.find({
      status: "needs_human",
      handoverAt: { $lte: addMinutes(now, -config.staffAlertMinutes), $gte: addMinutes(now, -24 * 60) },
    })
      .select("handoverAt lastStaffReplyAt channel")
      .lean<any[]>();
    for (const c of waiting) {
      if (!unanswered(c.handoverAt, c)) continue;
      const started = new Date(c.handoverAt).getTime();
      const base = { scopeType: "conversation" as const, scopeId: String(c._id) };
      jobs.push({
        ...base,
        dedupeKey: `chat:${c._id}:${started}:staff`,
        scheduledFor: addMinutes(new Date(started), config.staffAlertMinutes),
        data: { kind: "staff", since: c.handoverAt },
      });
      if (new Date(started) <= addMinutes(now, -config.patientMessageMinutes))
        jobs.push({
          ...base,
          dedupeKey: `chat:${c._id}:${started}:patient`,
          scheduledFor: addMinutes(new Date(started), config.patientMessageMinutes),
          urgent: true, // a reply in the patient's own open chat may go out during quiet hours
          data: { kind: "patient", since: c.handoverAt },
        });
    }

    // Taken over, patient wrote again, staff silent (the old inbox reminder)
    const idleCutoff = addMinutes(now, -(settings.assistantTakeoverReminderMinutes ?? 5));
    const idle = await ConversationModel.find({
      status: "human_active",
      lastInboundAt: { $lte: idleCutoff, $gte: addMinutes(now, -24 * 60) },
      $expr: { $gt: ["$lastInboundAt", { $ifNull: ["$lastStaffReplyAt", "$takenOverAt"] }] },
    })
      .select("lastInboundAt")
      .lean<any[]>();
    for (const c of idle)
      jobs.push({
        scopeType: "conversation",
        scopeId: String(c._id),
        dedupeKey: `chat:${c._id}:idle:${new Date(c.lastInboundAt).getTime()}`,
        scheduledFor: now,
        data: { kind: "idle", since: c.lastInboundAt },
      });
    return jobs;
  },
  async prepare(job, { now, settings }) {
    const c = await ConversationModel.findById(job.scopeId).lean<any>();
    if (!c) return fail("Conversation not found");
    const since = new Date(String(job.data.since));
    const kind = job.data.kind;
    if (kind === "idle") {
      if (c.status !== "human_active") return fail("Conversation is no longer taken over");
      if (c.lastStaffReplyAt && new Date(c.lastStaffReplyAt) >= since) return fail("Staff already replied");
    } else {
      if (!["needs_human", "human_active"].includes(c.status)) return fail("Conversation no longer needs a person");
      if (!unanswered(since, c)) return fail("Staff already replied");
    }
    if (kind === "patient") {
      if (
        c.channel === "whatsapp" &&
        !(c.lastInboundAt && now.getTime() - new Date(c.lastInboundAt).getTime() < WINDOW_MS)
      )
        return fail("Outside WhatsApp's 24-hour window");
      const linked = c.linkedPatientIds ?? [];
      return {
        ok: true,
        to: "conversation",
        conversationId: String(c._id),
        patientId: linked.length === 1 ? String(linked[0]) : null,
        language: c.language === "en" ? "en" : "bn",
        variables: { hospitalPhone: hospitalPhone(settings) },
        templateKey: "chat_waiting_patient",
        related: { type: "conversation", id: String(c._id) },
      };
    }
    return {
      ok: true,
      to: "staff",
      permission: "inbox:manage",
      loud: Boolean(c.emergency),
      variables: {
        waitingMinutes: String(Math.max(1, Math.round((now.getTime() - since.getTime()) / 60_000))),
        channel: CHANNEL_LABEL[c.channel] ?? c.channel,
        reason: kind === "idle" ? "Patient wrote again in a taken-over chat" : (c.handoverReason ?? "Needs a person"),
      },
      related: { type: "conversation", id: String(c._id) },
    };
  },
  async postSend(job) {
    if (job.data.kind === "patient") return;
    // The inbox bell and list react to the same signal as in Phase 5
    await ConversationModel.updateOne({ _id: job.scopeId }, { $set: { remindedAt: new Date() } });
    const c = await ConversationModel.findById(job.scopeId).select("emergency channel").lean<any>();
    emitToPermission("inbox:manage", "inbox:alert", {
      conversationId: job.scopeId,
      emergency: Boolean(c?.emergency),
      reminder: true,
      channel: c?.channel,
    });
  },
} satisfies RuleDefinition<ChatConfig>);
