/* eslint-disable @typescript-eslint/no-explicit-any */
import { env } from "../../../../config/env";
import { logger } from "../../../../utils/logger";
import { toE164Bd } from "../../../../utils/phone";
import { registerOtpSender } from "../../otp.service";
import type { InboundMessage } from "../../assistant.types";
import { ChatMessageModel } from "../../chatMessage.model";
import { ConversationDocument, ConversationModel } from "../../conversation.model";
import { handleInbound } from "../../engine";
import { registerAdapter } from "../index";
import type { ChannelAdapter, Delivery } from "../types";
import { isWhatsAppConfigured, markAsRead, toPayload, transportFor } from "./client";
import { renderForWhatsApp } from "./render";

/**
 * WHATSAPP CHANNEL ADAPTER
 *  inbound:  Meta webhook JSON → InboundMessage (text, button/list replies, "reply 2" numbered
 *            answers, unsupported media) → the SAME conversation engine as the web chat
 *  outbound: OutboundMessage → text / reply buttons / list messages (render.ts) → Cloud API
 *  statuses: sent / delivered / read / failed → ChatMessage.deliveryStatus
 * Free-form messages are only allowed within 24 hours of the patient's last message (WhatsApp's
 * customer service window). Proactive template messages are Phase 6.
 */

export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export const withinServiceWindow = (conv: { lastInboundAt?: Date | null }) =>
  Boolean(conv.lastInboundAt && Date.now() - new Date(conv.lastInboundAt).getTime() < SERVICE_WINDOW_MS);

// ------------------------------------------------------------------ outbound

const markFailed = (items: Delivery[], error: string) =>
  Promise.all(
    items.map(({ doc }) =>
      ChatMessageModel.updateOne({ _id: doc._id }, { $set: { deliveryStatus: "failed", deliveryError: error } }),
    ),
  );

export const whatsappAdapter: ChannelAdapter = {
  channel: "whatsapp",
  async deliver(conv: ConversationDocument, items: Delivery[]) {
    if (!items.length) return;
    if (!conv.simulated && !isWhatsAppConfigured()) return void (await markFailed(items, "WhatsApp is not configured"));
    if (!withinServiceWindow(conv))
      return void (await markFailed(items, "Outside WhatsApp's 24-hour window (templates come in Phase 6)"));

    const transport = transportFor(conv.simulated);
    let numbered: { n: number; id: string; label: string }[] | null = null;
    for (const { doc, message } of items) {
      const rendered = renderForWhatsApp(message);
      if (rendered.numberedOptions.length)
        numbered = rendered.numberedOptions.map((o, i) => ({ n: i + 1, id: o.id, label: o.label }));
      const payloads = rendered.bodies.map((b) => toPayload(conv.channelUserId, b));
      let firstId: string | null = null;
      let error: string | null = null;
      for (const payload of payloads) {
        const r = await transport.send(payload);
        if (r.ok) firstId ??= r.messageId;
        else error = r.error;
      }
      await ChatMessageModel.updateOne(
        { _id: doc._id },
        {
          $set: {
            externalMessageId: firstId,
            deliveryStatus: error ? "failed" : "sent",
            deliveryError: error,
            channelPayload: payloads,
          },
        },
      );
    }
    if (numbered) await ConversationModel.updateOne({ _id: conv._id }, { $set: { lastOptions: numbered } });
  },
};
registerAdapter(whatsappAdapter);

// ------------------------------------------------------------------ inbound

type WaMessage = {
  id: string;
  from: string;
  timestamp?: string;
  type: string;
  text?: { body: string };
  interactive?: {
    type: string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string };
  };
  button?: { text: string; payload?: string };
};

const UNSUPPORTED: Record<string, InboundMessage["unsupported"]> = {
  image: "image",
  audio: "audio",
  voice: "audio",
  video: "video",
  document: "document",
  location: "location",
  sticker: "sticker",
};

export const toInbound = (m: WaMessage, profileName?: string): InboundMessage => {
  const base = {
    channel: "whatsapp" as const,
    channelUserId: m.from,
    externalMessageId: m.id,
    profileName,
    timestamp: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date(),
  };
  if (m.type === "text") return { ...base, text: m.text?.body ?? "" };
  if (m.type === "interactive") {
    const reply = m.interactive?.button_reply ?? m.interactive?.list_reply;
    return { ...base, replyId: reply?.id, text: reply?.title };
  }
  if (m.type === "button") return { ...base, replyId: m.button?.payload, text: m.button?.text };
  return { ...base, unsupported: UNSUPPORTED[m.type] ?? "other" };
};

/** "2" after a numbered list = the second option (WhatsApp fallback for long lists) */
const mapNumberedReply = async (inbound: InboundMessage) => {
  const n = /^\s*(\d{1,2})\s*$/.exec(inbound.text ?? "")?.[1];
  if (!n || inbound.replyId) return inbound;
  const conv = await ConversationModel.findOne({ channel: "whatsapp", channelUserId: inbound.channelUserId }).select(
    "lastOptions",
  );
  const option = conv?.lastOptions?.find((o: { n: number }) => o.n === Number(n));
  return option ? { ...inbound, replyId: option.id, text: option.label } : inbound;
};

export type WebhookPayload = { object?: string; entry?: { changes?: { value?: any }[] }[] };

/**
 * Process one webhook call (already signature-checked). Messages are handled one by one, in order.
 * Idempotent: a message id that was processed before (Meta retries) is ignored by the engine.
 */
export const processWebhook = async (payload: WebhookPayload, opts: { simulated?: boolean } = {}) => {
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      for (const s of value.statuses ?? []) {
        await ChatMessageModel.updateOne(
          { channel: "whatsapp", externalMessageId: s.id },
          {
            $set: {
              deliveryStatus: s.status,
              ...(s.errors?.[0] && { deliveryError: String(s.errors[0].title ?? "").slice(0, 300) }),
            },
          },
        );
      }
      const names = new Map<string, string>((value.contacts ?? []).map((c: any) => [c.wa_id, c.profile?.name]));
      for (const m of (value.messages ?? []) as WaMessage[]) {
        try {
          if (opts.simulated)
            await ConversationModel.updateOne(
              { channel: "whatsapp", channelUserId: m.from },
              { $set: { simulated: true }, $setOnInsert: { status: "bot_active" } },
              { upsert: true },
            );
          const inbound = await mapNumberedReply(toInbound(m, names.get(m.from)));
          if (!opts.simulated) void markAsRead(m.id);
          const result = await handleInbound(inbound);
          if (result.duplicate) continue;
          await whatsappAdapter.deliver(
            result.conversation,
            result.stored.map((doc, i) => ({ doc, message: result.messages[i] })),
          );
        } catch (err) {
          logger.error({ err: (err as Error).message, waId: m.id }, "WhatsApp message processing failed");
        }
      }
    }
  }
};

// Webhook work runs after the 200 answer; tests (and shutdown) can wait for it
const inFlight = new Set<Promise<void>>();
export const processInBackground = (payload: WebhookPayload) => {
  const p = processWebhook(payload).finally(() => inFlight.delete(p));
  inFlight.add(p);
};
export const drainWhatsApp = async () => {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
};

// ------------------------------------------------------------------ OTP over WhatsApp

/**
 * Web-chat verification codes can go to WhatsApp when it is configured. Note: a number that has not
 * messaged the hospital in 24 hours needs an approved authentication TEMPLATE (Phase 6); a failed
 * send falls back to the next sender.
 */
registerOtpSender({
  name: "whatsapp",
  send: async (phone, code) => {
    if (!isWhatsAppConfigured()) return false;
    const to = (toE164Bd(phone) ?? phone).replace(/^\+/, "");
    const r = await transportFor(false).send(
      toPayload(to, {
        type: "text",
        text: { body: `Testolife verification code: ${code}\nআপনার যাচাই কোড: ${code} (৫ মিনিট বৈধ)` },
      }),
    );
    return r.ok;
  },
});

export const whatsappInfo = () => ({
  configured: isWhatsAppConfigured(),
  apiVersion: env.WHATSAPP_API_VERSION,
  phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID ? `•••${env.WHATSAPP_PHONE_NUMBER_ID.slice(-4)}` : null,
});
