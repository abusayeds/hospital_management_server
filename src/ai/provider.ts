/**
 * AI PROVIDER CONTRACT — every model vendor is hidden behind this interface, so features never
 * import a vendor SDK. Swapping Gemini for another provider = one new file in providers/.
 */
export type AiRequest = {
  system: string;
  prompt: string;
  json?: boolean; // ask the model for a JSON object (structured output)
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal; // the caller's timeout
};

export type AiResponse = {
  text: string;
  model: string; // the model that actually answered (after fallbacks)
  usage?: { inputTokens?: number; outputTokens?: number };
};

export interface AiProvider {
  readonly name: string;
  generate(request: AiRequest): Promise<AiResponse>;
}

/** Thrown by providers for failures worth one more try (overload, rate limit, network) */
export class RetryableAiError extends Error {}
