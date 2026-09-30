/**
 * AI PROVIDER CONTRACT — every model vendor is hidden behind this interface, so features never
 * import a vendor SDK. Swapping Gemini for another provider = one new file in providers/.
 *
 *  - generate(): one prompt in, text (or JSON) out — used by structured features (visit summary)
 *  - chat():     a conversation with TOOLS (function calling) — used by the patient assistant
 *  - embed():    text → vectors — used by the knowledge base search
 * chat() and embed() are optional: a provider without them simply cannot power those features.
 */
export type AiRequest = {
  system: string;
  prompt: string;
  json?: boolean; // ask the model for a JSON object (structured output)
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal; // the caller's timeout
};

export type AiUsage = { inputTokens?: number; outputTokens?: number };

export type AiResponse = {
  text: string;
  model: string; // the model that actually answered (after fallbacks)
  usage?: AiUsage;
};

// ------------------------------------------------------------------ tool calling

/** A tool the model may call. `parameters` is a JSON Schema object (arguments are re-validated in code). */
export type AiToolDef = { name: string; description: string; parameters: Record<string, unknown> };

export type AiToolCall = { id?: string; name: string; args: Record<string, unknown> };

/**
 * Provider-neutral conversation turns. `raw` keeps the vendor's own model turn so it can be sent
 * back unchanged (Gemini needs its "thought signatures" returned with function calls).
 */
export type AiTurn =
  | { role: "user"; text: string }
  | { role: "model"; text?: string; toolCalls?: AiToolCall[]; raw?: unknown }
  | { role: "tool"; results: { id?: string; name: string; result: unknown }[] };

export type AiChatRequest = {
  system: string;
  turns: AiTurn[];
  tools: AiToolDef[];
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
};

export type AiChatResponse = {
  text: string;
  toolCalls: AiToolCall[];
  raw?: unknown; // the vendor's model turn, to append to the next request as-is
  model: string;
  usage?: AiUsage;
};

export type AiEmbedResponse = { vectors: number[][]; model: string; usage?: AiUsage };

export interface AiProvider {
  readonly name: string;
  generate(request: AiRequest): Promise<AiResponse>;
  chat?(request: AiChatRequest): Promise<AiChatResponse>;
  embed?(texts: string[], opts?: { signal?: AbortSignal; purpose?: "document" | "query" }): Promise<AiEmbedResponse>;
}

/** Thrown by providers for failures worth one more try (overload, rate limit, network) */
export class RetryableAiError extends Error {}
