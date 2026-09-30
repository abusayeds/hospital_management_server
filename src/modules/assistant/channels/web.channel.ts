import { emitToRoom } from "../../../sockets";
import type { ChatMessageDocument } from "../chatMessage.model";
import type { ChannelAdapter } from "./types";

export const WEB_CHAT_COOKIE = "tl_chat";

/** What the web chat receives for one message (no internal ids except the message id) */
export const toWebMessage = (m: ChatMessageDocument | Record<string, unknown>) => {
  const d = m as unknown as {
    _id: unknown;
    sender: string;
    text: string;
    rich?: unknown;
    createdAt?: Date;
  };
  return { id: String(d._id), sender: d.sender, text: d.text, rich: d.rich ?? null, createdAt: d.createdAt };
};

/** Web chat: bot replies travel in the HTTP response; staff replies arrive on the visitor's socket room */
export const webAdapter: ChannelAdapter = {
  channel: "web",
  async deliver(conv, items) {
    for (const { doc } of items) emitToRoom(`webchat:${conv.channelUserId}`, "chat:message", toWebMessage(doc));
  },
};
