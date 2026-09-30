import type { z } from "zod";
import type { OutboundMessage } from "../assistant.types";
import type { ConversationDocument } from "../conversation.model";

/**
 * TOOL CONTRACT. The model decides WHICH tool to call; the tool decides WHAT is allowed.
 *  - arguments are re-validated with Zod (never trusted);
 *  - personal tools require the conversation's verified phone and re-check ownership in code;
 *  - `data` goes back to the model — keep it minimal (no phones, no real ids, no lab values);
 *  - `ui` is shown to the patient as rich messages (cards, lists, buttons), rendered by the channel.
 */
export type ToolContext = {
  conversation: ConversationDocument;
  ui: OutboundMessage[];
  bookedAppointmentIds: string[];
  preview?: boolean; // admin "test the assistant": no side effects
};

export type ToolOutput = { data: unknown; summary: string; ui?: OutboundMessage[] };

export type AssistantTool<S extends z.ZodTypeAny = z.ZodTypeAny> = {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema shown to the model
  schema: S;
  needsVerification?: boolean;
  run: (args: z.infer<S>, ctx: ToolContext) => Promise<ToolOutput>;
};

export const defineTool = <S extends z.ZodTypeAny>(tool: AssistantTool<S>) => tool;

/** Tool results never leave raw errors: business errors become a message the model can explain */
export type ToolError = { error: string; details?: unknown };
