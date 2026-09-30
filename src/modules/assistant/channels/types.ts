import type { Channel, OutboundMessage } from "../assistant.types";
import type { ChatMessageDocument } from "../chatMessage.model";
import type { ConversationDocument } from "../conversation.model";

/**
 * CHANNEL ADAPTER — the only channel-specific code. It turns provider events into InboundMessages
 * (in its route) and delivers OutboundMessages in its own format:
 *   web       → the HTTP response + a socket room for staff replies (React renders rich messages)
 *   whatsapp  → Cloud API text / reply buttons / list messages, numbered text when limits are hit
 *   voice (future) → speech-to-text → engine → text-to-speech; rich messages read out as text.
 * The conversation engine never changes when a channel is added.
 */
export type Delivery = { doc: ChatMessageDocument; message: OutboundMessage };

export interface ChannelAdapter {
  channel: Channel;
  /** Deliver messages created outside a request (staff replies, confirmations) */
  deliver(conv: ConversationDocument, items: Delivery[]): Promise<void>;
}
