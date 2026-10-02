import { z } from "zod";
import { TIME_PATTERN } from "../../../utils/date";
import { expiryReport } from "../../pharmacy/pharmacy.service";
import { atDhaka, dhakaDate } from "../time";
import { registerRule } from "./registry";
import { fail } from "./shared";
import type { RuleDefinition } from "./types";

/**
 * 13. PHARMACY EXPIRY ALERT — every morning (default 08:30) stock managers are told how many batches
 * expire within the next N days (and how many already expired with units on the shelf). Nothing is
 * sent when there is nothing to report. Low-stock alerts are sent straight after a dispense.
 */

type ExpiryConfig = { sendAt: string; withinDays: number };

export const pharmacyExpiryAlert = registerRule({
  key: "pharmacy_expiry_alert",
  title: "Pharmacy expiry alert",
  description:
    "Every morning (default 08:30) pharmacy staff are told how many medicine batches expire soon or have expired with units still on the shelf.",
  trigger: "daily",
  category: "internal",
  enabledByDefault: true,
  cadenceMinutes: 60,
  defaults: {
    sendAt: "08:30",
    withinDays: 30,
    quietHoursOverride: true,
    dailyLimit: 1000,
    channels: ["whatsapp" as const],
    templateKey: "pharmacy_expiry_alert",
  },
  configSchema: z
    .object({ sendAt: z.string().regex(TIME_PATTERN, "Use HH:mm"), withinDays: z.number().int().min(1).max(180) })
    .partial(),
  async plan({ now, config }) {
    const today = dhakaDate(now);
    return [
      {
        dedupeKey: `expiry:${today}`,
        scopeType: "system",
        scopeId: today,
        scheduledFor: atDhaka(today, config.sendAt),
      },
    ];
  },
  async prepare(job, { config }) {
    const report = await expiryReport(config.withinDays);
    const soon = report.summary.within30.batches + (config.withinDays > 30 ? report.summary.within90.batches : 0);
    const expired = report.summary.expired.batches;
    if (!soon && !expired) return fail("Nothing expiring");
    return {
      ok: true,
      to: "staff",
      permission: "stock:manage",
      variables: { days: String(config.withinDays), soon: String(soon), expired: String(expired) },
      related: { type: "system", id: `expiry:${job.scopeId}` },
    };
  },
} satisfies RuleDefinition<ExpiryConfig>);
