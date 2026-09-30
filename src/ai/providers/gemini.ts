import { GoogleGenAI } from "@google/genai";
import { logger } from "../../utils/logger";
import { AiProvider, AiRequest, AiResponse, RetryableAiError } from "../provider";

const RETRYABLE_STATUS = [429, 500, 503, 504];

/** Google Gemini. Tries the configured model first, then the fallback models (retired / overloaded). */
export const createGeminiProvider = (apiKey: string, models: string[]): AiProvider => {
  const client = new GoogleGenAI({ apiKey });
  return {
    name: "gemini",
    async generate(req: AiRequest): Promise<AiResponse> {
      let lastError: unknown = null;
      for (const model of models) {
        try {
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
        } catch (error) {
          if (req.signal?.aborted) throw error;
          const status = Number((error as { status?: number })?.status);
          logger.warn({ model, status }, "Gemini request failed");
          lastError = error;
          if (status === 404 || RETRYABLE_STATUS.includes(status)) continue; // next model
          throw error;
        }
      }
      throw new RetryableAiError(String((lastError as Error)?.message ?? "All models failed"));
    },
  };
};
