import type { AiChatRequest, AiChatResponse, AiProvider } from "../src/ai/provider";

/** Scripted fake model: each call returns the next scripted answer and records the request */
export const scriptedProvider = (script: ((req: AiChatRequest) => Partial<AiChatResponse>)[]) => {
  const calls: AiChatRequest[] = [];
  const provider: AiProvider = {
    name: "fake",
    generate: async () => ({ text: "{}", model: "fake" }),
    chat: async (req) => {
      calls.push(req);
      const step = script[Math.min(calls.length - 1, script.length - 1)];
      return { text: "", toolCalls: [], model: "fake", ...step(req) };
    },
  };
  return { provider, calls };
};
