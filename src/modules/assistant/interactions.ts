import type { OutboundMessage } from "./assistant.types";
import type { ConversationDocument } from "./conversation.model";

/**
 * DETERMINISTIC TAPS — some button presses are handled in code without calling the model
 * (cheaper, instant, and safe: e.g. a Confirm button can only confirm what the server prepared).
 * Everything else is turned into a sentence for the model by describeReply().
 */
export type InteractionResult = { messages: OutboundMessage[] } | null;

export type InteractionHandler = (
  conv: ConversationDocument,
  replyId: string,
  text: string | undefined,
) => Promise<InteractionResult>;

const handlers: InteractionHandler[] = [];

/** Tools and features register their own handlers (e.g. booking confirmations, OTP entry) */
export const registerInteraction = (handler: InteractionHandler) => handlers.push(handler);

export const handleInteraction = async (conv: ConversationDocument, replyId: string | undefined, text?: string) => {
  for (const h of handlers) {
    const result = await h(conv, replyId ?? "", text);
    if (result) return result;
  }
  return null;
};

/** Main menu shown on the first message and after errors */
export const MENU_OPTIONS = [
  { id: "menu|find_doctor", label: "ডাক্তার খুঁজুন · Find a doctor" },
  { id: "menu|book", label: "সিরিয়াল নিন · Book appointment" },
  { id: "menu|my_appointments", label: "আমার অ্যাপয়েন্টমেন্ট" },
  { id: "menu|report", label: "রিপোর্ট হয়েছে?" },
  { id: "menu|info", label: "হাসপাতালের তথ্য" },
  { id: "menu|human", label: "মানুষের সাথে কথা বলুন" },
];

const MENU_TEXT: Record<string, string> = {
  find_doctor: "I want to find a doctor.",
  book: "I want to book an appointment.",
  my_appointments: "Show my appointments.",
  report: "Is my lab report ready?",
  info: "Tell me about the hospital (address, hours, phone).",
  human: "I want to talk to a hospital staff member.",
};

/** A tapped option → what the patient means, in words the model understands */
export const describeReply = (replyId: string, label?: string): string => {
  const [kind, ...rest] = replyId.split("|");
  switch (kind) {
    case "menu":
      return MENU_TEXT[rest[0]] ?? label ?? "";
    case "dept":
      return `Show doctors of the ${rest[0]} department.`;
    case "doctor":
      return `I choose the doctor with doctorId ${rest[0]}. Show free slots.`;
    case "slot":
      return `Book doctorId ${rest[0]} on ${rest[1]} at ${rest[2]}.`;
    case "patient":
      return rest[0] === "new"
        ? "It is for someone else who is not registered yet. Ask me their name, age and gender."
        : `The appointment is for ${rest[0]}.`;
    case "appt":
      return `About appointment ${rest[0]}.`;
    default:
      return label ?? replyId;
  }
};
