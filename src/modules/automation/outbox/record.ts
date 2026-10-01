/* eslint-disable @typescript-eslint/no-explicit-any */
import { Types } from "mongoose";
import { logger } from "../../../utils/logger";
import { OutboxMessageModel, OutboxStatus } from "../models/outbox.model";

/**
 * Small, dependency-free part of the Outbox, imported by the chat channels (Phase 5 code):
 *  - recordChatSend: chatbot replies, staff inbox replies and system notices become Outbox rows
 *  - applyDeliveryStatus: WhatsApp delivery webhooks update the Outbox row (ChatMessage is updated
 *    by the webhook itself), so both always agree
 */

const WINDOW_MS = 24 * 60 * 60 * 1000;
const RANK: Record<string, number> = { queued: 0, sending: 1, sent: 2, delivered: 3, read: 4 };

type ConvLike = {
  _id: unknown;
  channel: string;
  channelUserId: string;
  verifiedPhone?: string | null;
  linkedPatientIds?: unknown[];
  language?: string;
  lastInboundAt?: Date | null;
};

type MessageLike = {
  _id: unknown;
  sender: string;
  text: string;
  rich?: any;
  staffUser?: unknown;
  externalMessageId?: string | null;
  deliveryStatus?: string | null;
  deliveryError?: string | null;
  channelPayload?: unknown;
};

const SOURCE: Record<string, "chatbot" | "staff" | "system"> = { bot: "chatbot", staff: "staff", system: "system" };

export const recipientOf = (conv: ConvLike) =>
  conv.verifiedPhone ??
  (conv.channel === "whatsapp" ? `+${conv.channelUserId}` : `web:${String(conv.channelUserId).slice(0, 8)}`);

/** Record conversation messages that were just delivered (best effort: never breaks the chat) */
export const recordChatSend = async (conv: ConvLike, messages: MessageLike[]) => {
  if (!messages.length) return;
  try {
    const linked = conv.linkedPatientIds ?? [];
    await OutboxMessageModel.insertMany(
      messages.map((m) => {
        const status: OutboxStatus =
          m.deliveryStatus === "failed"
            ? "failed"
            : conv.channel === "web"
              ? "delivered"
              : ((m.deliveryStatus as OutboxStatus) ?? "sent");
        const options = m.rich?.options ?? [];
        return {
          patient: linked.length === 1 ? linked[0] : null,
          toType: "patient",
          toRef: recipientOf(conv),
          channel: conv.channel === "whatsapp" ? "whatsapp" : "web",
          source: SOURCE[m.sender] ?? "system",
          messageKind: "session",
          renderedText: String(m.text ?? "").slice(0, 4096),
          interactive: options.length
            ? { buttons: options.slice(0, 10).map((o: any) => ({ id: o.id, label: o.label })) }
            : null,
          language: conv.language === "en" ? "en" : "bn",
          sentAt: status === "failed" ? null : new Date(),
          status,
          providerMessageId: m.externalMessageId ?? null,
          error: m.deliveryError ?? null,
          deliveryUpdates: [{ status, at: new Date(), error: m.deliveryError ?? null }],
          relatedType: "conversation",
          relatedId: String(conv._id),
          conversation: conv._id,
          chatMessage: m._id,
          createdBy: m.sender === "staff" && m.staffUser ? new Types.ObjectId(String(m.staffUser)) : null,
          replyWindowClosesAt: conv.lastInboundAt ? new Date(new Date(conv.lastInboundAt).getTime() + WINDOW_MS) : null,
          payload: m.channelPayload ?? null,
        };
      }),
    );
  } catch (err) {
    logger.error({ err: (err as Error).message }, "Outbox: could not record chat messages");
  }
};

/** A provider status (sent / delivered / read / failed) for a sent message. Statuses only move forward. */
export const applyDeliveryStatus = async (providerMessageId: string, status: string, error?: string | null) => {
  const row = await OutboxMessageModel.findOne({ providerMessageId });
  if (!row) return null;
  const next = status as OutboxStatus;
  if (next !== "failed" && (RANK[next] ?? -1) <= (RANK[row.status] ?? -1)) return row;
  row.status = next;
  if (next === "failed") row.error = error?.slice(0, 500) ?? row.error ?? "Delivery failed";
  row.deliveryUpdates.push({ status: next, at: new Date(), error: error ?? null });
  await row.save();
  return row;
};
