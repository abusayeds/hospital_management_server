import { Content, GoogleGenAI, Part } from "@google/genai";
import { logger } from "../../utils/logger";
import {
  AiChatRequest,
  AiChatResponse,
  AiEmbedResponse,
  AiProvider,
  AiRequest,
  AiResponse,
  AiTurn,
  RetryableAiError,
} from "../provider";

const RETRYABLE_STATUS = [429, 500, 503, 504];

/**
 * Try each model in order: a retired model (404) or an overloaded one (429/5xx) falls through to the
 * next; any other error is final. Aborts (our timeout) are never retried.
 */
const withModelFallback = async <T>(
  models: string[],
  signal: AbortSignal | undefined,
  run: (model: string) => Promise<T>,
) => {
  let lastError: unknown = null;
  for (const model of models) {
    try {
      return await run(model);
    } catch (error) {
      if (signal?.aborted) throw error;
      const status = Number((error as { status?: number })?.status);
      logger.warn({ model, status }, "Gemini request failed");
      lastError = error;
      if (status === 404 || RETRYABLE_STATUS.includes(status)) continue;
      throw error;
    }
  }
  throw new RetryableAiError(String((lastError as Error)?.message ?? "All models failed"));
};

/** Provider-neutral turns → Gemini contents */
const toContents = (turns: AiTurn[]): Content[] =>
  turns.map((t): Content => {
    if (t.role === "user") return { role: "user", parts: [{ text: t.text }] };
    if (t.role === "tool")
      return {
        role: "user",
        parts: t.results.map((r) => ({ functionResponse: { id: r.id, name: r.name, response: { result: r.result } } })),
      };
    if (t.raw) return t.raw as Content; // keeps Gemini's thought signatures
    const parts: Part[] = [];
    if (t.text) parts.push({ text: t.text });
    for (const c of t.toolCalls ?? []) parts.push({ functionCall: { id: c.id, name: c.name, args: c.args } });
    return { role: "model", parts };
  });

/** Google Gemini. Tries the configured model first, then the fallback models (retired / overloaded). */
export const createGeminiProvider = (
  apiKey: string,
  models: string[],
  opts: { embeddingModel?: string; embeddingDimensions?: number } = {},
): AiProvider => {
  const client = new GoogleGenAI({ apiKey });
  return {
    name: "gemini",

    async generate(req: AiRequest): Promise<AiResponse> {
      return withModelFallback(models, req.signal, async (model) => {
        const res = await client.models.generateContent({
          model,
          contents: [{ role: "user", parts: [{ text: req.prompt }] }],
          config: {
            systemInstruction: req.system,
            temperature: req.temperature ?? 0.2,
            maxOutputTokens: req.maxOutputTokens,
            ...(req.json && { responseMimeType: "application/json" }),
            abortSignal: req.signal,
          },
        });
        return {
          text: res.text ?? "",
          model,
          usage: {
            inputTokens: res.usageMetadata?.promptTokenCount,
            outputTokens: res.usageMetadata?.candidatesTokenCount,
          },
        };
      });
    },

    async chat(req: AiChatRequest): Promise<AiChatResponse> {
      return withModelFallback(models, req.signal, async (model) => {
        const res = await client.models.generateContent({
          model,
          contents: toContents(req.turns),
          config: {
            systemInstruction: req.system,
            temperature: req.temperature ?? 0.3,
            maxOutputTokens: req.maxOutputTokens,
            tools: req.tools.length
              ? [
                  {
                    functionDeclarations: req.tools.map((t) => ({
                      name: t.name,
                      description: t.description,
                      parametersJsonSchema: t.parameters,
                    })),
                  },
                ]
              : undefined,
            abortSignal: req.signal,
          },
        });
        const calls = res.functionCalls ?? [];
        return {
          text: calls.length ? "" : (res.text ?? "").trim(),
          toolCalls: calls.map((c) => ({
            id: c.id,
            name: String(c.name),
            args: (c.args ?? {}) as Record<string, unknown>,
          })),
          raw: res.candidates?.[0]?.content,
          model,
          usage: {
            inputTokens: res.usageMetadata?.promptTokenCount,
            outputTokens: res.usageMetadata?.candidatesTokenCount,
          },
        };
      });
    },

    async embed(texts, embedOpts): Promise<AiEmbedResponse> {
      const model = opts.embeddingModel ?? "gemini-embedding-001";
      try {
        const res = await client.models.embedContent({
          model,
          contents: texts,
          config: {
            taskType: embedOpts?.purpose === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
            outputDimensionality: opts.embeddingDimensions ?? 768,
            abortSignal: embedOpts?.signal,
          },
        });
        return { vectors: (res.embeddings ?? []).map((e) => e.values ?? []), model };
      } catch (error) {
        const status = Number((error as { status?: number })?.status);
        if (RETRYABLE_STATUS.includes(status)) throw new RetryableAiError(String((error as Error).message));
        throw error;
      }
    },
  };
};
