import type { z } from "zod";
import type { Permission } from "../../../config/permissions";
import type { DomainEventMap, DomainEventName } from "../../../events/catalog";
import type { HospitalSettings } from "../../hospital/settings/settings.service";
import type { AutomationJobDocument, ScopeType } from "../models/job.model";
import type { OutboxMessageDocument } from "../models/outbox.model";

/**
 * THE RULE CONTRACT. A rule is a small object in code; the engine does everything else (storing
 * jobs, quiet hours, limits, preferences, rendering, channels, outbox, run log).
 *
 *   events / plan  → which jobs SHOULD exist (idempotent: same input → same dedupe keys)
 *   prepare        → at SEND time: re-check preconditions and collect the template variables
 *   postSend       → what to mark afterwards (e.g. appointment.reminderSentAt)
 */

/** Which patient preference switch a rule obeys */
export type RuleCategory = "reminders" | "followUps" | "labReports" | "marketing" | "essential" | "internal";

export type BaseRuleConfig = {
  quietHoursOverride: boolean; // urgent jobs of this rule may send during quiet hours
  dailyLimit: number; // max sends per day for this rule (deferred to tomorrow beyond it)
  channels: ("whatsapp" | "sms")[]; // patient channel order
  templateKey: string;
};

/** One job a planner or event handler wants to exist */
export type PlannedJob = {
  dedupeKey: string;
  scopeType: ScopeType;
  scopeId: string;
  scheduledFor: Date;
  patientId?: string | null;
  urgent?: boolean;
  data?: Record<string, unknown>;
  supersedes?: string; // rescheduled: the OLD appointment id whose open jobs this one replaces
};

export type RuleContext<C> = { now: Date; config: C & BaseRuleConfig; settings: HospitalSettings };

/** What to send, decided at send time */
export type Prepared =
  | { ok: false; reason: string } // precondition failed → job cancelled, never sent
  | {
      ok: true;
      to: "patient";
      patientId: string;
      phone: string;
      language?: "bn" | "en";
      variables: Record<string, unknown>;
      buttonRef?: string; // id the reply buttons carry (e.g. the appointment id)
      templateKey?: string; // overrides the rule's template (e.g. walk-in welcome)
      related: { type: "appointment" | "visit" | "lab_order" | "conversation" | "doctor" | "patient"; id: string };
    }
  | {
      ok: true;
      to: "staff";
      permission: Permission; // every online user with this permission sees it in-app
      variables: Record<string, unknown>;
      related: { type: "conversation" | "system" | "appointment"; id: string };
      loud?: boolean; // red + sound in the staff UI
      templateKey?: string;
      onCallPhones?: string[]; // optional WhatsApp copy to on-call staff
    }
  | {
      ok: true;
      to: "conversation"; // a message into an open chat (web or WhatsApp) through its own channel
      conversationId: string;
      patientId?: string | null;
      language?: "bn" | "en";
      variables: Record<string, unknown>;
      templateKey?: string;
      related: { type: "conversation"; id: string };
    };

export type EventHandlers<C> = {
  [N in DomainEventName]?: (payload: DomainEventMap[N], ctx: RuleContext<C>) => Promise<PlannedJob[] | void>;
};

export interface RuleDefinition<C extends Record<string, unknown> = Record<string, unknown>> {
  key: string;
  title: string;
  description: string;
  trigger: string; // human text for the admin ("appointment.booked", "every 15 minutes")
  category: RuleCategory;
  /** Sends even after "STOP" (emergencies, the hospital cancelling a booking) — never marketing */
  essential?: boolean;
  /** Counted against the per-phone daily cap (reminder-style messages) */
  countsTowardPhoneCap?: boolean;
  enabledByDefault: boolean;
  defaults: C & BaseRuleConfig;
  /** Validates the rule-specific part of the config (timings) */
  configSchema: z.ZodType<Partial<C>>;
  /** Planner cadence in minutes (omit for event-only rules) */
  cadenceMinutes?: number;
  events?: EventHandlers<C>;
  plan?: (ctx: RuleContext<C>) => Promise<PlannedJob[]>;
  prepare: (job: AutomationJobDocument, ctx: RuleContext<C>) => Promise<Prepared>;
  postSend?: (job: AutomationJobDocument, outbox: OutboxMessageDocument, ctx: RuleContext<C>) => Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRule = RuleDefinition<any>;
