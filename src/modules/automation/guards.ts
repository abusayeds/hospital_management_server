import type { HospitalSettings } from "../hospital/settings/settings.service";
import type { PatientPreferences } from "../patients/patient.model";
import type { DecisionReason } from "./models/job.model";
import { OutboxMessageModel } from "./models/outbox.model";
import { allRules } from "./rules/registry";
import type { AnyRule, BaseRuleConfig } from "./rules/types";
import { inQuietHours, nextDhakaMidnight, quietHoursEndAfter, startOfDhakaDayFor } from "./time";

/**
 * RESPONSIBLE-MESSAGING GUARDS, checked by the dispatcher right before every patient send.
 *   skip  → the job is closed with a reason (opt-out, duplicate) — it will never send
 *   defer → the job goes back to "scheduled" at a later time (quiet hours, limits) — never dropped
 * Every result carries a reason code, stored on the job, so "why did / didn't this send?" is answerable.
 */

export type GuardResult =
  | { action: "send" }
  | { action: "skip"; reason: DecisionReason; detail: string }
  | { action: "defer"; reason: DecisionReason; until: Date; detail: string };

const SEND: GuardResult = { action: "send" };
const NOT_SENT = { $nin: ["failed", "cancelled"] };

export const DEFAULT_PREFERENCES: PatientPreferences = {
  reminders: true,
  followUps: true,
  labReports: true,
  marketing: false,
  language: "bn",
  optOutAll: false,
};

/** Opt-outs: STOP silences everything except essential messages; marketing needs an explicit opt-in */
export const checkPreferences = (rule: AnyRule, prefs: Partial<PatientPreferences> | undefined): GuardResult => {
  const p = { ...DEFAULT_PREFERENCES, ...(prefs ?? {}) };
  if (rule.category === "internal") return SEND;
  if (rule.category === "marketing") {
    if (p.optOutAll || !p.marketing)
      return { action: "skip", reason: "optOut", detail: "Marketing needs the patient's opt-in" };
    return SEND;
  }
  if (rule.essential) return SEND;
  if (p.optOutAll) return { action: "skip", reason: "optOut", detail: "Patient opted out of all messages (STOP)" };
  if (rule.category !== "essential" && p[rule.category] === false)
    return { action: "skip", reason: "optOut", detail: `Patient turned off ${rule.category}` };
  return SEND;
};

/** Quiet hours: non-urgent messages wait for the morning; urgent ones may pass if the rule allows */
export const checkQuietHours = (
  now: Date,
  settings: Pick<HospitalSettings, "quietHoursStart" | "quietHoursEnd">,
  config: Pick<BaseRuleConfig, "quietHoursOverride">,
  urgent: boolean,
): GuardResult => {
  if (!inQuietHours(now, settings.quietHoursStart, settings.quietHoursEnd)) return SEND;
  if (urgent && config.quietHoursOverride) return SEND;
  return {
    action: "defer",
    reason: "quietHours",
    until: quietHoursEndAfter(now, settings.quietHoursStart, settings.quietHoursEnd),
    detail: `Quiet hours ${settings.quietHoursStart}–${settings.quietHoursEnd}`,
  };
};

/** When a daily limit is hit: first moment of tomorrow that is also outside quiet hours */
const tomorrowMorning = (now: Date, settings: Pick<HospitalSettings, "quietHoursStart" | "quietHoursEnd">) =>
  quietHoursEndAfter(nextDhakaMidnight(now), settings.quietHoursStart, settings.quietHoursEnd);

/** Per-rule daily limit, global daily budget and per-phone daily cap */
export const checkLimits = async (
  now: Date,
  rule: AnyRule,
  config: Pick<BaseRuleConfig, "dailyLimit">,
  settings: Pick<HospitalSettings, "automationDailyBudget" | "perPhoneDailyCap" | "quietHoursStart" | "quietHoursEnd">,
  phone: string,
): Promise<GuardResult> => {
  const since = startOfDhakaDayFor(now);
  const base = { source: "automation", toType: "patient", createdAt: { $gte: since }, status: NOT_SENT };

  const ruleToday = await OutboxMessageModel.countDocuments({ ...base, ruleKey: rule.key });
  if (ruleToday >= config.dailyLimit)
    return {
      action: "defer",
      reason: "rateLimit",
      until: tomorrowMorning(now, settings),
      detail: `Rule limit of ${config.dailyLimit} per day reached`,
    };

  const allToday = await OutboxMessageModel.countDocuments(base);
  if (allToday >= settings.automationDailyBudget)
    return {
      action: "defer",
      reason: "budgetExceeded",
      until: tomorrowMorning(now, settings),
      detail: `Daily budget of ${settings.automationDailyBudget} messages reached`,
    };

  if (rule.countsTowardPhoneCap) {
    const capped = allRules()
      .filter((r) => r.countsTowardPhoneCap)
      .map((r) => r.key);
    const phoneToday = await OutboxMessageModel.countDocuments({ ...base, toRef: phone, ruleKey: { $in: capped } });
    if (phoneToday >= settings.perPhoneDailyCap)
      return {
        action: "defer",
        reason: "rateLimit",
        until: tomorrowMorning(now, settings),
        detail: `This phone already got ${settings.perPhoneDailyCap} messages today`,
      };
  }
  return SEND;
};

/** The same text to the same phone a few minutes ago (e.g. two rules, two family bookings) → suppress */
export const checkDuplicate = async (
  now: Date,
  phone: string,
  text: string,
  settings: Pick<HospitalSettings, "dedupeWindowMinutes">,
): Promise<GuardResult> => {
  if (!settings.dedupeWindowMinutes) return SEND;
  const recent = await OutboxMessageModel.exists({
    toRef: phone,
    renderedText: text,
    createdAt: { $gte: new Date(now.getTime() - settings.dedupeWindowMinutes * 60_000) },
    status: NOT_SENT,
  });
  return recent
    ? {
        action: "skip",
        reason: "duplicateSuppressed",
        detail: `Same message sent to this phone in the last ${settings.dedupeWindowMinutes} min`,
      }
    : SEND;
};
