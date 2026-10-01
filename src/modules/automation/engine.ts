import { env } from "../../config/env";
import { subscribe } from "../../events/bus";
import type { DomainEventName } from "../../events/catalog";
import { logger } from "../../utils/logger";
import { dispatchNow } from "./dispatcher";
import { planJobs, startRun } from "./jobs";
import { AutomationJobModel } from "./models/job.model";
import { ruleContext } from "./rules/config";
import { allRules } from "./rules/registry";
import type { AnyRule, PlannedJob } from "./rules/types";

/**
 * AUTOMATION ENGINE — glue between rules and the rest of the system.
 *  - wireEvents(): every rule's event handlers subscribe to the domain event bus (consumer
 *    "automation:<rule>", so the DomainEvent log shows each rule's processing status)
 *  - runPlanner(): a rule's planner for one moment; jobs are PLANNED, not sent (the queue is visible)
 * Jobs due right now (a booking confirmation) are dispatched immediately instead of on the next tick.
 */

export const runtime = { immediateDispatch: env.NODE_ENV !== "test" };

const IMMEDIATE_MS = 5_000;

const dispatchImmediate = async (ruleKey: string, planned: PlannedJob[], now: Date) => {
  if (!runtime.immediateDispatch) return;
  for (const p of planned) {
    if (p.scheduledFor.getTime() > now.getTime() + IMMEDIATE_MS) continue;
    const job = await AutomationJobModel.findOne({ ruleKey, dedupeKey: p.dedupeKey })
      .select("_id")
      .lean<{ _id: unknown }>();
    if (job) await dispatchNow(job._id);
  }
};

/** React to one event for one rule (also called directly by tests) */
export const handleRuleEvent = async <N extends DomainEventName>(
  rule: AnyRule,
  name: N,
  payload: unknown,
  now = new Date(),
) => {
  const handler = rule.events?.[name] as ((p: unknown, ctx: unknown) => Promise<PlannedJob[] | void>) | undefined;
  if (!handler) return { created: 0, updated: 0 };
  const ctx = await ruleContext(rule, now);
  if (!ctx.enabled) return { created: 0, updated: 0 };
  const finishRun = await startRun(rule.key, "event", name);
  try {
    const planned = (await handler(payload, ctx)) ?? [];
    const counts = await planJobs(rule.key, planned);
    await finishRun({ scanned: 1, created: counts.created });
    await dispatchImmediate(rule.key, planned, now);
    return counts;
  } catch (err) {
    await finishRun({ scanned: 1, errors: [(err as Error).message] });
    throw err;
  }
};

let wired = false;
export const wireEvents = () => {
  if (wired) return;
  wired = true;
  for (const rule of allRules())
    for (const name of Object.keys(rule.events ?? {}) as DomainEventName[])
      subscribe(name, `automation:${rule.key}`, (event) =>
        handleRuleEvent(rule, name, event.payload).then(() => undefined),
      );
};

// Planner runs are logged when they did something, plus one heartbeat per hour per rule
const lastLogged = new Map<string, number>();

export type PlannerResult = { planned: PlannedJob[]; created: number; updated: number; skipped?: string };

export const runPlanner = async (
  rule: AnyRule,
  now = new Date(),
  opts: { dryRun?: boolean } = {},
): Promise<PlannerResult> => {
  if (!rule.plan) return { planned: [], created: 0, updated: 0, skipped: "event-only rule" };
  const ctx = await ruleContext(rule, now);
  if (!ctx.enabled && !opts.dryRun) return { planned: [], created: 0, updated: 0, skipped: "disabled" };
  try {
    const planned = await rule.plan(ctx);
    if (opts.dryRun) return { planned, created: 0, updated: 0 };
    const counts = await planJobs(rule.key, planned);
    const heartbeatDue = Date.now() - (lastLogged.get(rule.key) ?? 0) > 60 * 60_000;
    if (counts.created || counts.updated || heartbeatDue) {
      lastLogged.set(rule.key, Date.now());
      const finishRun = await startRun(rule.key, "planner", "cron");
      await finishRun({ scanned: planned.length, created: counts.created });
    }
    await dispatchImmediate(rule.key, planned, now);
    return { planned, ...counts };
  } catch (err) {
    logger.error({ err: (err as Error).message, rule: rule.key }, "Automation planner failed");
    const finishRun = await startRun(rule.key, "planner", "cron");
    await finishRun({ errors: [(err as Error).message] });
    return { planned: [], created: 0, updated: 0, skipped: "error" };
  }
};
