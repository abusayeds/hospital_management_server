import mongoose, { HydratedDocument, Schema, Types } from "mongoose";
import { CHANNELS, Channel, OutboundMessage } from "./assistant.types";

/**
 * One message in a conversation — from the patient, the assistant, a staff member or the system.
 * Tool calls are stored with SANITISED arguments and a short result summary (for the inbox's
 * "Assistant checked doctor availability" chips and for debugging), never full personal data.
 */
export type ToolCallLog = {
  name: string;
  arguments: Record<string, unknown>;
  resultSummary: string;
  success: boolean;
  latencyMs: number;
};

export interface IChatMessage {
  conversation: Types.ObjectId;
  channel: Channel;
  direction: "inbound" | "outbound";
  sender: "patient" | "bot" | "staff" | "system";
  staffUser?: Types.ObjectId | null;
  text: string;
  rich?: OutboundMessage | null; // structured bot output (cards, lists, buttons)
  replyId?: string | null; // the button / list row the patient tapped
  toolCalls: ToolCallLog[];
  externalMessageId?: string | null; // WhatsApp message id (inbound or outbound)
  deliveryStatus?: "pending" | "sent" | "delivered" | "read" | "failed" | null;
  deliveryError?: string | null;
  latencyMs?: number | null;
  model?: string | null;
  guardFlags: string[]; // output guard findings (e.g. "dosage_pattern")
  createdAt?: Date;
}

export type ChatMessageDocument = HydratedDocument<IChatMessage>;

const ChatMessageSchema = new Schema<IChatMessage>(
  {
    conversation: { type: Schema.Types.ObjectId, ref: "Conversation", required: true },
    channel: { type: String, enum: CHANNELS, required: true },
    direction: { type: String, enum: ["inbound", "outbound"], required: true },
    sender: { type: String, enum: ["patient", "bot", "staff", "system"], required: true },
    staffUser: { type: Schema.Types.ObjectId, ref: "User", default: null },
    text: { type: String, default: "", maxlength: 4000 },
    rich: { type: Schema.Types.Mixed, default: null },
    replyId: { type: String, default: null, maxlength: 200 },
    toolCalls: {
      type: [
        new Schema<ToolCallLog>(
          {
            name: String,
            arguments: Schema.Types.Mixed,
            resultSummary: String,
            success: Boolean,
            latencyMs: Number,
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    externalMessageId: { type: String, default: null },
    deliveryStatus: {
      type: String,
      enum: ["pending", "sent", "delivered", "read", "failed", null],
      default: null,
    },
    deliveryError: { type: String, default: null, maxlength: 300 },
    latencyMs: { type: Number, default: null },
    model: { type: String, default: null },
    guardFlags: { type: [String], default: [] },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

ChatMessageSchema.index({ conversation: 1, createdAt: 1 });
// Idempotency: a provider message id is processed once per channel (WhatsApp retries its webhooks)
ChatMessageSchema.index(
  { channel: 1, externalMessageId: 1 },
  { unique: true, partialFilterExpression: { externalMessageId: { $type: "string" } } },
);

export const ChatMessageModel =
  mongoose.models.ChatMessage || mongoose.model<IChatMessage>("ChatMessage", ChatMessageSchema);
