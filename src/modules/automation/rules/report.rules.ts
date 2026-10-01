import { z } from "zod";
import { TIME_PATTERN } from "../../../utils/date";
import { generateDailyReport, headlineOf, markDelivered } from "../../reports/dailyReport.service";
import { atDhaka, dhakaDate } from "../time";
import { registerRule } from "./registry";
import type { RuleDefinition } from "./types";

/**
 * 12. AI DAILY REPORT — at 21:30 (configurable) the day's numbers are turned into a short Bangla
 * narrative (AI, or the bullet fallback) and management is told in-app; optional WhatsApp copies go to
 * the phones in `recipientPhones`. The message carries only a headline; the full report is on
 * Management → Reports. No patient data is in the report or the message.
 */

type ReportConfig = { sendAt: string; recipientPhones: string[] };

export const dailyAiReport = registerRule({
  key: "daily_ai_report",
  title: "AI daily report",
  description:
    "At the end of the day (default 21:30) the AI writes a short Bangla report of the day's numbers (no patient data) for management; if the AI is unavailable a plain bullet summary is used. Optional WhatsApp copies to listed phones.",
  trigger: "daily",
  category: "internal",
  enabledByDefault: true,
  cadenceMinutes: 60,
  defaults: {
    sendAt: "21:30",
    recipientPhones: [],
    quietHoursOverride: true,
    dailyLimit: 1000,
    channels: ["whatsapp" as const],
    templateKey: "daily_ai_report",
  },
  configSchema: z
    .object({
      sendAt: z.string().regex(TIME_PATTERN, "Use HH:mm"),
      recipientPhones: z.array(z.string().regex(/^\+8801[3-9]\d{8}$/, "Use +8801XXXXXXXXX")).max(5),
    })
    .partial(),
  async plan({ now, config }) {
    const today = dhakaDate(now);
    return [
      {
        dedupeKey: `ai-report:${today}`,
        scopeType: "system",
        scopeId: today,
        scheduledFor: atDhaka(today, config.sendAt),
      },
    ];
  },
  async prepare(job, { config }) {
    const date = job.scopeId;
    // A resend reuses the stored report; the scheduled run writes a fresh one
    const report = await generateDailyReport(date, { reuse: Boolean(job.data?.resend) });
    await markDelivered(date);
    return {
      ok: true,
      to: "staff",
      permission: "report:operations",
      variables: { date, source: report.source === "ai" ? "AI" : "সারাংশ", headline: headlineOf(report) },
      onCallPhones: config.recipientPhones,
      related: { type: "system", id: `report:${date}` },
    };
  },
} satisfies RuleDefinition<ReportConfig>);
