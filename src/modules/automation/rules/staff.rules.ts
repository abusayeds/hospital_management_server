/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from "zod";
import { TIME_PATTERN } from "../../../utils/date";
import { ConversationModel } from "../../assistant/conversation.model";
import { LabOrderModel } from "../../clinical/lab/labOrder.model";
import { AppointmentModel } from "../../hospital/appointment/appointment.model";
import { PatientModel } from "../../patients/patient.model";
import { OutboxMessageModel } from "../models/outbox.model";
import { addMinutes, atDhaka, dhakaDate, startOfDhakaDayFor } from "../time";
import { registerRule } from "./registry";
import { fail, firstName, hospitalNameFor, languageOf } from "./shared";
import type { RuleDefinition } from "./types";

/**
 * 10. INTERNAL ALERTS (in-app; emergencies can also go to on-call staff on WhatsApp)
 *   staff_emergency_alert — an emergency conversation lands in the inbox
 *   staff_failure_alert   — many automated sends failed in the last hour
 *   daily_digest          — plain end-of-day numbers for management (the AI narrative is Phase 7)
 * 11. BIRTHDAY GREETING — marketing, OFF by default, only to patients who opted in.
 */

const time = z.string().regex(TIME_PATTERN, "Use HH:mm");
const bdPhone = z.string().regex(/^\+8801[3-9]\d{8}$/, "Use +8801XXXXXXXXX");
const staffDefaults = { quietHoursOverride: true, dailyLimit: 1000, channels: ["whatsapp" as const] };

// ------------------------------------------------------------------ 10a. emergency alert

type EmergencyConfig = { onCallPhones: string[] };

export const staffEmergencyAlert = registerRule({
  key: "staff_emergency_alert",
  title: "Emergency chat alert",
  description:
    "A new emergency conversation in the inbox: immediate, loud alert for inbox staff, plus an optional WhatsApp copy to on-call phones.",
  trigger: "chat.handover_requested (emergency)",
  category: "internal",
  enabledByDefault: true,
  defaults: { onCallPhones: [], ...staffDefaults, templateKey: "staff_emergency_alert" },
  configSchema: z.object({ onCallPhones: z.array(bdPhone).max(5) }).partial(),
  events: {
    "chat.handover_requested": async (p, { now }) =>
      p.emergency
        ? [
            {
              // At most one alert per conversation per hour
              dedupeKey: `chat:${p.conversationId}:emergency:${now.toISOString().slice(0, 13)}`,
              scopeType: "conversation",
              scopeId: p.conversationId,
              scheduledFor: now,
              urgent: true,
              data: { reason: p.reason, channel: p.channel },
            },
          ]
        : [],
  },
  async prepare(job, { config }) {
    const c = await ConversationModel.findById(job.scopeId).select("status").lean<any>();
    if (!c) return fail("Conversation not found");
    if (c.status === "resolved") return fail("Conversation already resolved");
    return {
      ok: true,
      to: "staff",
      permission: "inbox:manage",
      loud: true,
      variables: { channel: job.data.channel === "whatsapp" ? "WhatsApp" : "Web chat", reason: job.data.reason },
      onCallPhones: config.onCallPhones,
      related: { type: "conversation", id: job.scopeId },
    };
  },
} satisfies RuleDefinition<EmergencyConfig>);

// ------------------------------------------------------------------ 10b. failure alert

export const staffFailureAlert = registerRule({
  key: "staff_failure_alert",
  title: "Message failure alert",
  description:
    "If more automated messages failed in the last hour than the threshold in Settings, admins get an in-app alert with the most common error.",
  trigger: "every 15 minutes",
  category: "internal",
  enabledByDefault: true,
  cadenceMinutes: 15,
  defaults: { ...staffDefaults, templateKey: "staff_failure_alert" },
  configSchema: z.object({}).partial(),
  async plan({ now, settings }) {
    const failed = await OutboxMessageModel.countDocuments({
      source: "automation",
      status: "failed",
      createdAt: { $gte: addMinutes(now, -60) },
    });
    if (failed < settings.failureAlertThreshold) return [];
    return [
      {
        dedupeKey: `failures:${now.toISOString().slice(0, 13)}`,
        scopeType: "system",
        scopeId: "outbox",
        scheduledFor: now,
      },
    ];
  },
  async prepare(_job, { now, settings }) {
    const rows = await OutboxMessageModel.aggregate([
      { $match: { source: "automation", status: "failed", createdAt: { $gte: addMinutes(now, -60) } } },
      { $group: { _id: "$error", n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ]);
    const count = rows.reduce((a, r) => a + r.n, 0);
    if (count < settings.failureAlertThreshold) return fail("Failures dropped below the threshold");
    return {
      ok: true,
      to: "staff",
      permission: "settings:manage",
      variables: { count: String(count), topError: String(rows[0]?._id ?? "unknown").slice(0, 120) },
      related: { type: "system", id: "outbox" },
    };
  },
} satisfies RuleDefinition<Record<string, unknown>>);

// ------------------------------------------------------------------ 10c. daily digest

type DigestConfig = { sendAt: string };

export const dailyDigest = registerRule({
  key: "daily_digest",
  title: "Daily operations digest",
  description:
    "At the end of the day (default 21:30) management sees plain counts: appointments, no-shows, pending lab reports, chats and bookings via chat/WhatsApp.",
  trigger: "daily",
  category: "internal",
  enabledByDefault: true,
  cadenceMinutes: 60,
  defaults: { sendAt: "21:30", ...staffDefaults, templateKey: "daily_digest" },
  configSchema: z.object({ sendAt: time }).partial(),
  async plan({ now, config }) {
    const today = dhakaDate(now);
    return [
      {
        dedupeKey: `digest:${today}`,
        scopeType: "system",
        scopeId: today,
        scheduledFor: atDhaka(today, config.sendAt),
      },
    ];
  },
  async prepare(job) {
    const date = job.scopeId;
    const since = startOfDhakaDayFor(atDhaka(date, "12:00"));
    const until = addMinutes(since, 24 * 60);
    const byStatus = await AppointmentModel.aggregate([
      { $match: { date, isDeleted: { $ne: true } } },
      { $group: { _id: "$status", n: { $sum: 1 } } },
    ]);
    const count = (s: string) => byStatus.find((r) => r._id === s)?.n ?? 0;
    const [pendingLab, chats, chatBookings, messagesSent] = await Promise.all([
      LabOrderModel.countDocuments({
        status: { $in: ["ordered", "sample_collected", "processing", "awaiting_verification"] },
      }),
      ConversationModel.countDocuments({ lastMessageAt: { $gte: since, $lt: until } }),
      AppointmentModel.countDocuments({
        source: { $in: ["chatbot", "whatsapp"] },
        createdAt: { $gte: since, $lt: until },
      }),
      OutboxMessageModel.countDocuments({
        toType: "patient",
        createdAt: { $gte: since, $lt: until },
        status: { $nin: ["failed", "cancelled"] },
      }),
    ]);
    return {
      ok: true,
      to: "staff",
      permission: "report:operations",
      variables: {
        date,
        appointments: String(byStatus.reduce((a, r) => a + r.n, 0)),
        completed: String(count("completed")),
        noShows: String(count("no_show")),
        cancelled: String(count("cancelled")),
        pendingLab: String(pendingLab),
        chats: String(chats),
        chatBookings: String(chatBookings),
        messagesSent: String(messagesSent),
      },
      related: { type: "system", id: `digest:${date}` },
    };
  },
} satisfies RuleDefinition<DigestConfig>);

// ------------------------------------------------------------------ 11. birthday greeting

type BirthdayConfig = { sendAt: string };

export const birthdayGreeting = registerRule({
  key: "birthday_greeting",
  title: "Birthday greeting",
  description:
    "A simple greeting on the patient's birthday. Marketing: OFF by default and only for patients who opted in to promotional messages.",
  trigger: "daily",
  category: "marketing",
  countsTowardPhoneCap: true,
  enabledByDefault: false,
  cadenceMinutes: 60,
  defaults: {
    sendAt: "10:00",
    quietHoursOverride: false,
    dailyLimit: 200,
    channels: ["whatsapp"],
    templateKey: "birthday_greeting",
  },
  configSchema: z.object({ sendAt: time }).partial(),
  async plan({ now, config }) {
    const today = dhakaDate(now);
    const [, m, d] = today.split("-").map(Number);
    const patients = await PatientModel.find({
      dobEstimated: false,
      "preferences.marketing": true,
      "preferences.optOutAll": { $ne: true },
      $expr: { $and: [{ $eq: [{ $month: "$dateOfBirth" }, m] }, { $eq: [{ $dayOfMonth: "$dateOfBirth" }, d] }] },
    })
      .select("_id")
      .limit(500)
      .lean<any[]>();
    return patients.map((p) => ({
      dedupeKey: `bday:${p._id}:${today.slice(0, 4)}`,
      scopeType: "patient" as const,
      scopeId: String(p._id),
      scheduledFor: atDhaka(today, config.sendAt),
      patientId: String(p._id),
    }));
  },
  async prepare(job, { settings }) {
    const p = await PatientModel.findById(job.scopeId).select("name nameBn phone preferences").lean<any>();
    if (!p) return fail("Patient not found");
    const lang = languageOf(p);
    return {
      ok: true,
      to: "patient",
      patientId: String(p._id),
      phone: p.phone,
      language: lang,
      variables: {
        patientName: firstName(lang === "bn" && p.nameBn ? p.nameBn : p.name),
        hospital: hospitalNameFor(settings, lang),
      },
      related: { type: "patient", id: String(p._id) },
    };
  },
} satisfies RuleDefinition<BirthdayConfig>);
