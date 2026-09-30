import { Types } from "mongoose";
import { z } from "zod";
import { env } from "../config/env";
import AppError from "../errors/AppError";
import { logger } from "../utils/logger";
import { AiProvider, RetryableAiError } from "./provider";
import { createGeminiProvider } from "./providers/gemini";
import { AiUsageModel } from "./usage.model";

/**
 * AI SERVICE — the only way features call a model.
 *
 *  - provider chosen from env (AI_PROVIDER / AI_API_KEY / AI_MODEL), swappable in tests;
 *  - hard timeout (AI_TIMEOUT_MS) and input size limit (AI_MAX_INPUT_CHARS);
 *  - one retry for overload / broken JSON, then a clear, safe error — never a raw vendor error;
 *  - structured output validated with Zod: a feature only ever receives the shape it expects;
 *  - every call logged to AiUsage (no prompt or answer text is stored).
 *
 * Features must pass DE-IDENTIFIED input only (see deidentify.ts).
 */

export type PromptDef<I> = {
  id: string; // feature name, e.g. "visit-summary"
  version: string; // bump when the prompt changes (stored with every result and usage row)
  system: string;
  build: (input: I) => string;
  temperature?: number;
  maxOutputTokens?: number;
};

export const aiSettings = {
  timeoutMs: env.AI_TIMEOUT_MS,
  maxInputChars: env.AI_MAX_INPUT_CHARS,
};

let override: AiProvider | null | undefined;
let configured: AiProvider | null | undefined;

const buildProvider = (): AiProvider | null => {
  if (env.AI_PROVIDER === "none") return null;
  const key = env.AI_API_KEY ?? env.GEMINI_API_KEY;
  if (!key) return null;
  const first = env.AI_MODEL ?? env.GEMINI_MODEL;
  return createGeminiProvider(key, [first, ...env.GEMINI_FALLBACK_MODELS.filter((m) => m !== first)]);
};

export const getAiProvider = (): AiProvider | null => {
  if (override !== undefined) return override;
  configured ??= buildProvider();
  return configured;
};
export const isAiConfigured = () => Boolean(getAiProvider());

/** Tests (and a future admin switch) replace the provider; pass undefined to go back to env */
export const setAiProvider = (provider: AiProvider | null | undefined) => {
  override = provider;
};

class AiTimeout extends Error {}

const withTimeout = async <T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> => {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AiTimeout());
    }, ms);
  });
  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/** Models sometimes wrap JSON in ``` fences or add a sentence; take the outermost object */
export const extractJson = (text: string): unknown => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new SyntaxError("No JSON object in the answer");
  return JSON.parse(text.slice(start, end + 1));
};

type RunOptions<I, O> = {
  prompt: PromptDef<I>;
  input: I;
  schema: z.ZodType<O>;
  userId?: string;
  entityId?: string;
};

export type AiResult<O> = { data: O; model: string; promptVersion: string; latencyMs: number };

export const generateStructured = async <I, O>(opts: RunOptions<I, O>): Promise<AiResult<O>> => {
  const provider = getAiProvider();
  if (!provider)
    throw new AppError(503, "AI features are not configured on this server (AI_API_KEY).", "AI_NOT_CONFIGURED");

  const promptText = opts.prompt.build(opts.input);
  if (promptText.length > aiSettings.maxInputChars)
    throw new AppError(413, "Too much data for one AI request.", "AI_UNAVAILABLE");

  const started = Date.now();
  const log = (status: "ok" | "timeout" | "invalid_output" | "error", extra: Record<string, unknown> = {}) =>
    AiUsageModel.create({
      feature: opts.prompt.id,
      provider: provider.name,
      promptVersion: opts.prompt.version,
      status,
      latencyMs: Date.now() - started,
      inputChars: promptText.length,
      user: opts.userId && Types.ObjectId.isValid(opts.userId) ? opts.userId : null,
      entityId: opts.entityId ?? null,
      ...extra,
    }).catch((err: unknown) => logger.error({ err }, "Failed to write AI usage log"));

  let lastProblem: "invalid_output" | "error" = "error";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await withTimeout(
        (signal) =>
          provider.generate({
            system: opts.prompt.system,
            prompt: promptText,
            json: true,
            temperature: opts.prompt.temperature,
            maxOutputTokens: opts.prompt.maxOutputTokens,
            signal,
          }),
        aiSettings.timeoutMs,
      );
      const parsed = opts.schema.safeParse(
        (() => {
          try {
            return extractJson(res.text);
          } catch {
            return undefined;
          }
        })(),
      );
      if (!parsed.success) {
        lastProblem = "invalid_output";
        logger.warn({ feature: opts.prompt.id, attempt }, "AI answer did not match the expected shape");
        continue;
      }
      await log("ok", {
        model: res.model,
        outputChars: res.text.length,
        inputTokens: res.usage?.inputTokens ?? null,
        outputTokens: res.usage?.outputTokens ?? null,
      });
      return {
        data: parsed.data,
        model: res.model,
        promptVersion: opts.prompt.version,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      if (err instanceof AiTimeout) {
        await log("timeout");
        throw new AppError(503, "The AI service took too long. Try again in a moment.", "AI_UNAVAILABLE");
      }
      lastProblem = "error";
      logger.warn({ feature: opts.prompt.id, attempt, err: (err as Error).message }, "AI request failed");
      if (!(err instanceof RetryableAiError) && attempt === 1) {
        // Non-retryable vendor errors (bad key, blocked content): stop now
        await log("error", { error: String((err as Error).message).slice(0, 300) });
        throw new AppError(503, "The AI service is not available right now.", "AI_UNAVAILABLE");
      }
    }
  }
  await log(lastProblem);
  throw lastProblem === "invalid_output"
    ? new AppError(502, "The AI answer could not be used. Try again.", "AI_INVALID_OUTPUT")
    : new AppError(503, "The AI service is not available right now.", "AI_UNAVAILABLE");
};
