/* eslint-disable @typescript-eslint/no-explicit-any */
import crypto from "crypto";
import { Request } from "express";
import { Types } from "mongoose";
import { generateStructured, isAiConfigured } from "../../../ai/ai.service";
import { VisitSummaryContent, visitSummaryPrompt, visitSummarySchema } from "../../../ai/prompts/visit-summary.v1";
import AppError from "../../../errors/AppError";
import { subscribe } from "../../../events/bus";
import { recordAudit } from "../../audit/audit.service";
import { assertEmrAccess } from "../emr-access";
import { AiSummaryModel } from "./aiSummary.model";
import { buildSummaryContext } from "./context";

/**
 * AI VISIT SUMMARY — a brief of the patient's past records shown to the doctor.
 *
 * Safety: only de-identified data is sent (context.ts); the answer must match a strict schema;
 * it is always labelled "AI-generated — verify before use"; it is NEVER written into the visit
 * automatically (the doctor may copy parts, which marks the visit "aiSummaryUsed").
 * Every view, generation and feedback is audited.
 */

export const AI_LABEL = "AI-generated — verify before use";

const toView = (s: any, userId: string) => ({
  patientId: String(s.patient),
  content: s.content as VisitSummaryContent,
  label: AI_LABEL,
  promptVersion: s.promptVersion,
  model: s.model,
  generatedAt: s.generatedAt,
  stale: Boolean(s.stale),
  staleReason: s.staleReason ?? null,
  myFeedback: (s.feedback ?? []).find((f: any) => String(f.user) === userId)?.rating ?? null,
});

export const getSummary = async (req: Request, patientId: string) => {
  await assertEmrAccess(req, patientId);
  const s = await AiSummaryModel.findOne({ patient: patientId }).lean<any>();
  if (s) await recordAudit({ req, action: "VIEW", entityType: "AiSummary", entityId: s._id, meta: { patientId } });
  return { configured: isAiConfigured(), summary: s ? toView(s, req.user!.id) : null };
};

export const generateSummary = async (req: Request, patientId: string, force = false) => {
  await assertEmrAccess(req, patientId);
  const built = await buildSummaryContext(patientId);
  if (!built) throw new AppError(404, "Patient not found.");
  if (!built.hasHistory)
    throw new AppError(409, "No earlier visits, vitals or lab results to summarise yet.", "CONFLICT");

  const contextHash = crypto.createHash("sha256").update(`${visitSummaryPrompt.version}:${built.json}`).digest("hex");
  const cached = await AiSummaryModel.findOne({ patient: patientId }).lean<any>();
  if (cached && !force && !cached.stale && cached.contextHash === contextHash) return toView(cached, req.user!.id);

  const result = await generateStructured({
    prompt: visitSummaryPrompt,
    input: built.context,
    schema: visitSummarySchema,
    userId: req.user!.id,
    entityId: patientId,
  });
  const saved = await AiSummaryModel.findOneAndUpdate(
    { patient: patientId },
    {
      $set: {
        content: result.data,
        promptVersion: result.promptVersion,
        model: result.model,
        contextHash,
        generatedAt: new Date(),
        generatedBy: new Types.ObjectId(req.user!.id),
        stale: false,
        staleReason: null,
        feedback: [],
      },
    },
    { upsert: true, new: true },
  ).lean<any>();
  await recordAudit({
    req,
    action: "CREATE",
    entityType: "AiSummary",
    entityId: saved._id,
    meta: {
      patientId,
      promptVersion: result.promptVersion,
      model: result.model,
      latencyMs: result.latencyMs,
      regenerated: Boolean(cached),
    },
  });
  return toView(saved, req.user!.id);
};

export const giveFeedback = async (
  req: Request,
  patientId: string,
  input: { rating: "up" | "down"; comment?: string },
) => {
  await assertEmrAccess(req, patientId);
  const s = await AiSummaryModel.findOne({ patient: patientId });
  if (!s) throw new AppError(404, "No summary to rate.");
  s.feedback = s.feedback.filter((f: any) => String(f.user) !== req.user!.id);
  s.feedback.push({
    user: new Types.ObjectId(req.user!.id),
    rating: input.rating,
    comment: input.comment,
    at: new Date(),
  });
  await s.save();
  await recordAudit({
    req,
    action: "UPDATE",
    entityType: "AiSummary",
    entityId: s._id,
    meta: { feedback: input.rating, comment: input.comment ?? null, promptVersion: s.promptVersion },
  });
  return toView(s.toObject(), req.user!.id);
};

// New facts make the cached brief out of date (event bus consumers, see events/catalog.ts)
const markStale = (reason: string) => async (event: { payload: { patientId: string } }) => {
  await AiSummaryModel.updateOne({ patient: event.payload.patientId }, { $set: { stale: true, staleReason: reason } });
};
subscribe("visit.closed", "ai-summary-invalidate", markStale("A new visit was closed"));
subscribe("lab.report_ready", "ai-summary-invalidate", markStale("A new lab report was verified"));

export const aiSummaryService = { getSummary, generateSummary, giveFeedback };
