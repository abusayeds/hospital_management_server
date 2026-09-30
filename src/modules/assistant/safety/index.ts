import type { OutboundMessage } from "../assistant.types";
import type { ConversationDocument } from "../conversation.model";

/** Safety hooks used by the engine. Step C fills these in (emergency, limits, output guard). */
export type PreCheckResult = { stop: true; messages: OutboundMessage[] } | null;

export const preChecks = async (_conv: ConversationDocument, _text: string): Promise<PreCheckResult> => null;

export const guardOutput = (text: string, _conv: ConversationDocument) => ({ text, flags: [] as string[] });
