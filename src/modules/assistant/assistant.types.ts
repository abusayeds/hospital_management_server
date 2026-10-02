/**
 * The assistant's channel-independent message format.
 *
 * Every channel (web chat, WhatsApp, later voice) converts its own events INTO an InboundMessage
 * and renders OutboundMessages in its own way. The conversation engine only ever sees these
 * shapes, so adding a channel never changes the engine.
 */

export const CHANNELS = ["web", "whatsapp"] as const;
export type Channel = (typeof CHANNELS)[number];

export type InboundMessage = {
  channel: Channel;
  channelUserId: string; // web: anonymous session id · WhatsApp: the sender's number (digits)
  text?: string; // typed text (or the title of a tapped button, for display)
  replyId?: string; // id of a tapped quick reply / list row / card action
  timestamp?: Date;
  externalMessageId?: string; // provider message id (WhatsApp) → idempotency
  profileName?: string; // WhatsApp display name (staff inbox only; never sent to the AI)
  unsupported?: "image" | "audio" | "video" | "document" | "location" | "sticker" | "other";
};

/** A choice the patient can tap. `meta` carries display extras for rich renderers (fee, time, …). */
export type ReplyOption = {
  id: string;
  label: string;
  description?: string;
  meta?: Record<string, unknown>;
};

export type CardKind =
  | "doctor_day"
  | "booking_summary"
  | "booking_success"
  | "cancel_summary"
  | "reschedule_summary"
  | "cancel_success"
  | "queue_status"
  | "appointment"
  | "lab_status"
  | "hospital_info";

export type OutboundMessage =
  | { type: "text"; text: string }
  | { type: "quick_replies"; text: string; options: ReplyOption[] }
  | {
      type: "list";
      kind: "doctors" | "slots" | "patients" | "appointments" | "departments" | "options";
      text: string;
      button: string; // WhatsApp list button label
      items: ReplyOption[];
    }
  | {
      type: "card";
      kind: CardKind;
      title: string;
      fields: { label: string; value: string }[];
      data?: Record<string, unknown>;
      actions?: ReplyOption[];
    }
  | { type: "otp_request"; text: string; phoneMasked: string; resendAfterSeconds: number }
  | { type: "handover"; text: string; emergency?: boolean };

/** Plain-text version of any message (conversation memory, WhatsApp fallback, inbox previews) */
export const messageText = (m: OutboundMessage): string => {
  switch (m.type) {
    case "text":
    case "handover":
    case "otp_request":
      return m.text;
    case "quick_replies":
      return m.text;
    case "list":
      return `${m.text}\n${m.items.map((i, n) => `${n + 1}. ${i.label}${i.description ? ` — ${i.description}` : ""}`).join("\n")}`;
    case "card":
      return `${m.title}\n${m.fields.map((f) => `${f.label}: ${f.value}`).join("\n")}`;
  }
};
