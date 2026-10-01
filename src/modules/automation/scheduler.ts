import cron, { ScheduledTask } from "node-cron";
import { logger } from "../../utils/logger";
import { getSettings } from "../hospital/settings/settings.service";
import { releaseLeases, tick, WORKER_ID } from "./dispatcher";
import { runPlanner } from "./engine";
import { allRules } from "./rules/registry";

/**
 * SCHEDULER WORKER (node-cron, once a minute):
 *   1. dispatcher tick — sends every due job (lease-protected, safe with several processes)
 *   2. planners whose cadence matches this minute (1 = every minute, 15, 60 …)
 * Stopped on shutdown, after which this worker's leases are released.
 */

let task: ScheduledTask | null = null;
let busy = false;
export const schedulerStatus = {
  running: false,
  startedAt: null as Date | null,
  lastTickAt: null as Date | null,
  workerId: WORKER_ID,
};

export const runMinute = async (now = new Date()) => {
  const settings = await getSettings();
  if (settings.automationPaused) return;
  await tick();
  const minute = Math.floor(now.getTime() / 60_000);
  for (const rule of allRules())
    if (rule.plan && rule.cadenceMinutes && minute % rule.cadenceMinutes === 0) await runPlanner(rule, now);
};

export const startScheduler = () => {
  if (task) return;
  task = cron.schedule("* * * * *", () => {
    if (busy) return; // a slow minute is never overlapped by the next one
    busy = true;
    schedulerStatus.lastTickAt = new Date();
    runMinute()
      .catch((err) => logger.error({ err: (err as Error).message }, "Automation scheduler tick failed"))
      .finally(() => {
        busy = false;
      });
  });
  schedulerStatus.running = true;
  schedulerStatus.startedAt = new Date();
  // Catch up once at start: every planner runs now instead of waiting for its next cadence slot
  void (async () => {
    for (const rule of allRules()) if (rule.plan) await runPlanner(rule).catch(() => undefined);
  })();
  logger.info({ workerId: WORKER_ID }, "Automation scheduler started");
};

export const stopScheduler = async () => {
  task?.stop();
  task = null;
  schedulerStatus.running = false;
  const released = await releaseLeases();
  if (released) logger.info({ released }, "Automation: released job leases");
};
