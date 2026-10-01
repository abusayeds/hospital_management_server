/* eslint-disable @typescript-eslint/no-explicit-any */
import { Types } from "mongoose";
import { AutomationJobModel, Decision, OPEN_JOB_STATUSES, ScopeType } from "./models/job.model";
import { AutomationRunModel, IAutomationRun } from "./models/run.model";
import type { PlannedJob } from "./rules/types";

/**
 * Job bookkeeping shared by planners, event consumers and the dispatcher.
 * planJobs is idempotent: the unique (ruleKey, dedupeKey) index means "create if missing" — a planner
 * may run every minute and an event may be delivered twice without a second job ever appearing.
 */

export type PlanCounts = { created: number; updated: number };

export const planJobs = async (ruleKey: string, planned: PlannedJob[]): Promise<PlanCounts> => {
  const counts = { created: 0, updated: 0 };
  for (const p of planned) {
    try {
      const res = await AutomationJobModel.updateOne(
        { ruleKey, dedupeKey: p.dedupeKey },
        {
          $setOnInsert: {
            ruleKey,
            dedupeKey: p.dedupeKey,
            scopeType: p.scopeType,
            scopeId: p.scopeId,
            patient: p.patientId ? new Types.ObjectId(p.patientId) : null,
            scheduledFor: p.scheduledFor,
            originalScheduledFor: p.scheduledFor,
            status: "scheduled",
            urgent: Boolean(p.urgent),
            data: p.data ?? {},
          },
        },
        { upsert: true },
      );
      if (res.upsertedCount) counts.created += 1;
      else {
        // Timing changed in the settings (e.g. reminder hour) → move a not-yet-deferred job
        const moved = await AutomationJobModel.updateOne(
          {
            ruleKey,
            dedupeKey: p.dedupeKey,
            status: "scheduled",
            deferCount: 0,
            scheduledFor: { $ne: p.scheduledFor },
          },
          { $set: { scheduledFor: p.scheduledFor, originalScheduledFor: p.scheduledFor } },
        );
        counts.updated += moved.modifiedCount;
      }
    } catch (err) {
      // Two planners raced on the same key: the unique index kept exactly one — that is the point
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }
  return counts;
};

const decision = (action: Decision["action"], reason: Decision["reason"], detail?: string): Decision => ({
  at: new Date(),
  action,
  reason,
  ...(detail && { detail: detail.slice(0, 300) }),
});

/** Cancel every open job of a scope (e.g. all reminders of a cancelled appointment) */
export const cancelOpenJobs = async (
  filter: { scopeType: ScopeType; scopeId: string; ruleKey?: string | { $in: string[] } },
  reason: string,
) => {
  const res = await AutomationJobModel.updateMany(
    { ...filter, status: { $in: OPEN_JOB_STATUSES } },
    {
      $set: { status: "cancelled", cancelReason: reason.slice(0, 300), lease: null },
      $push: { decisions: decision("cancelled", "preconditionFailed", reason) },
    },
  );
  return res.modifiedCount;
};

/**
 * Rescheduled appointment: every open job of the old appointment becomes "superseded", linked to the new
 * appointment's job of the same rule (if one was planned), so the admin sees the chain.
 */
export const supersedeJobs = async (fromScopeId: string, toScopeId: string) => {
  const old = await AutomationJobModel.find({
    scopeType: "appointment",
    scopeId: fromScopeId,
    status: { $in: OPEN_JOB_STATUSES },
  }).lean<any[]>();
  for (const job of old) {
    const replacement = await AutomationJobModel.findOne({
      ruleKey: job.ruleKey,
      scopeType: "appointment",
      scopeId: toScopeId,
    })
      .select("_id")
      .lean<any>();
    await AutomationJobModel.updateOne(
      { _id: job._id, status: { $in: OPEN_JOB_STATUSES } },
      {
        $set: { status: "superseded", supersededBy: replacement?._id ?? null, cancelReason: "Appointment rescheduled" },
        $push: { decisions: decision("cancelled", "superseded", `Rescheduled to appointment ${toScopeId}`) },
      },
    );
  }
  return old.length;
};

export const pushDecision = decision;

/** Open a run record; call the returned finish() with the counts */
export const startRun = async (
  ruleKey: string,
  kind: IAutomationRun["kind"],
  trigger: string | null,
  dryRun = false,
) => {
  const run = await AutomationRunModel.create({ ruleKey, kind, trigger, startedAt: new Date(), dryRun });
  return async (counts: Partial<Omit<IAutomationRun, "ruleKey" | "kind" | "startedAt">>) => {
    await AutomationRunModel.updateOne(
      { _id: run._id },
      { $set: { ...counts, errors: (counts.errors ?? []).slice(0, 20), finishedAt: new Date() } },
    );
  };
};
