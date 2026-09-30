import { publish } from "../../events/bus";
import { emitToPermission } from "../../sockets";
import type { ConversationDocument } from "./conversation.model";

/**
 * Staff inbox signals (ids and status only — the inbox fetches the details with permission).
 *  inbox:updated → a conversation changed (new message, status)
 *  inbox:alert   → someone needs a human now (emergency = true → red + sound)
 */
export const notifyInbox = (conv: ConversationDocument) =>
  emitToPermission("inbox:manage", "inbox:updated", {
    conversationId: String(conv._id),
    status: conv.status,
    emergency: conv.emergency,
    channel: conv.channel,
  });

/**
 * Ask a human to look at this conversation. The assistant keeps answering (unless staff take over),
 * but the conversation is flagged, shown first in the inbox and a domain event is published.
 */
export const requestHandover = async (
  conv: ConversationDocument,
  reason: string,
  opts: { emergency?: boolean } = {},
) => {
  if (conv.status !== "human_active") conv.status = "needs_human";
  conv.handoverReason = reason.slice(0, 300);
  conv.handoverAt = new Date();
  conv.metrics.handoverCount += 1;
  if (opts.emergency) {
    conv.emergency = true;
    if (!conv.tags.includes("EMERGENCY")) conv.tags.push("EMERGENCY");
  }
  await conv.save();
  emitToPermission("inbox:manage", "inbox:alert", {
    conversationId: String(conv._id),
    emergency: Boolean(opts.emergency),
    channel: conv.channel,
  });
  notifyInbox(conv);
  void publish("chat.handover_requested", {
    conversationId: String(conv._id),
    channel: conv.channel,
    reason: conv.handoverReason,
    emergency: Boolean(opts.emergency),
  });
};
