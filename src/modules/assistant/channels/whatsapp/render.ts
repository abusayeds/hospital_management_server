import { messageText, OutboundMessage, ReplyOption } from "../../assistant.types";

/**
 * OutboundMessage → WhatsApp Cloud API message bodies.
 *
 * WhatsApp limits (checked here, not by Meta at send time):
 *   reply buttons: max 3, title ≤ 20 chars · list: max 10 rows, row title ≤ 24, description ≤ 72,
 *   button text ≤ 20, body ≤ 1024 · text ≤ 4096.
 * When a rich message does not fit, it becomes NUMBERED TEXT ("1. …, 2. …") and the options are
 * remembered on the conversation, so a reply of "2" maps back to the same choice.
 */

export const LIMITS = {
  buttons: 3,
  buttonTitle: 20,
  rows: 10,
  rowTitle: 24,
  rowDescription: 72,
  listButton: 20,
  body: 1024,
  text: 4096,
};

export type WaBody = Record<string, unknown>; // one message body (without messaging_product / to)
export type Rendered = { bodies: WaBody[]; numberedOptions: ReplyOption[] };

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const text = (body: string): WaBody[] => {
  const parts: WaBody[] = [];
  for (let i = 0; i < body.length; i += LIMITS.text)
    parts.push({ type: "text", text: { body: body.slice(i, i + LIMITS.text), preview_url: false } });
  return parts.length ? parts : [{ type: "text", text: { body: " " } }];
};

const numbered = (intro: string, options: ReplyOption[]): Rendered => ({
  bodies: text(
    `${intro}\n\n${options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`).join("\n")}\n\nউত্তরে নম্বর লিখুন · Reply with the number`,
  ),
  numberedOptions: options,
});

/** Titles must be short: use one half of "বাংলা · English" labels when the whole does not fit */
const shortTitle = (label: string, max: number = LIMITS.buttonTitle) => {
  if (label.length <= max) return label;
  const pick = label.split(" · ").find((p) => p.length <= max);
  return pick ?? cut(label, max);
};

const buttons = (body: string, options: ReplyOption[]): Rendered => {
  if (options.length > LIMITS.buttons || body.length > LIMITS.body) return numbered(body, options);
  return {
    bodies: [
      {
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: body || "…" },
          action: {
            buttons: options.map((o) => ({ type: "reply", reply: { id: cut(o.id, 256), title: shortTitle(o.label) } })),
          },
        },
      },
    ],
    numberedOptions: [],
  };
};

const list = (body: string, button: string, options: ReplyOption[]): Rendered => {
  if (options.length > LIMITS.rows || body.length > LIMITS.body) return numbered(body, options);
  return {
    bodies: [
      {
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: body || "…" },
          action: {
            button: cut(button || "Choose", LIMITS.listButton),
            sections: [
              {
                title: "Options",
                rows: options.map((o) => ({
                  id: cut(o.id, 200),
                  title: shortTitle(o.label, LIMITS.rowTitle),
                  ...(o.description && { description: cut(o.description, LIMITS.rowDescription) }),
                })),
              },
            ],
          },
        },
      },
    ],
    numberedOptions: [],
  };
};

export const renderForWhatsApp = (m: OutboundMessage): Rendered => {
  switch (m.type) {
    case "text":
    case "handover":
      return { bodies: text(m.text), numberedOptions: [] };
    case "otp_request":
      return { bodies: text(m.text), numberedOptions: [] };
    case "quick_replies":
      return m.options.length <= LIMITS.buttons
        ? buttons(m.text, m.options)
        : list(m.text, "বেছে নিন · Choose", m.options);
    case "list":
      return list(m.text, m.button, m.items);
    case "card": {
      const body = messageText(m);
      return m.actions?.length ? buttons(body, m.actions) : { bodies: text(body), numberedOptions: [] };
    }
  }
};
