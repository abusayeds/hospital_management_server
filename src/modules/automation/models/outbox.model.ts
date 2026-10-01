import mongoose, { HydratedDocument, Schema, Types } from "mongoose";

/**
 * MESSAGE OUTBOX — the single source of truth for EVERY outgoing message: automation, chatbot
 * replies, staff inbox replies, internal staff alerts and admin test sends. Nothing is sent without a
 * row here, so "what did we send to this patient, when, and did it arrive?" has one answer.
 * renderedText is the exact text for audit; it never contains lab values, diagnoses or prescriptions.
 */

export const OUTBOX_STATUSES = ["queued", "sending", "sent", "delivered", "read", "failed", "cancelled"] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];
export const OUTBOX_CHANNELS = ["whatsapp", "sms", "web", "inapp"] as const;
export type OutboxChannel = (typeof OUTBOX_CHANNELS)[number];
export const OUTBOX_SOURCES = ["automation", "chatbot", "staff", "system", "test"] as const;
export type OutboxSource = (typeof OUTBOX_SOURCES)[number];

export type DeliveryUpdate = { status: OutboxStatus; at: Date; error?: string | null };
export type OutboxButton = { id: string; label: string };

export interface IOutboxMessage {
  patient?: Types.ObjectId | null; // null for staff-targeted messages
  toType: "patient" | "staff" | "admin";
  toRef: string; // phone (+8801…), web visitor id, or a permission / user id for in-app alerts
  channel: OutboxChannel;
  source: OutboxSource;
  messageKind: "session" | "template" | "sms" | "inapp";
  templateKey?: string | null;
  templateVersion?: number | null;
  whatsappTemplateName?: string | null;
  variables: Record<string, string>;
  renderedText: string;
  interactive?: { buttons: OutboxButton[] } | null;
  language: "bn" | "en";
  scheduledFor?: Date | null;
  sentAt?: Date | null;
  status: OutboxStatus;
  providerMessageId?: string | null;
  error?: string | null;
  deliveryUpdates: DeliveryUpdate[];
  cost?: number | null; // reserved for Phase 7 billing of messaging costs
  relatedType?: "appointment" | "visit" | "lab_order" | "conversation" | "doctor" | "system" | null;
  relatedId?: string | null;
  ruleKey?: string | null; // null for chatbot / staff / manual sends
  job?: Types.ObjectId | null;
  conversation?: Types.ObjectId | null;
  chatMessage?: Types.ObjectId | null;
  createdBy?: Types.ObjectId | null; // staff user for staff replies and test sends; null = system
  replyWindowClosesAt?: Date | null; // WhatsApp 24 h customer-service window at send time
  payload?: unknown; // what was handed to the provider (debugging)
  retryOf?: Types.ObjectId | null;
  repliedAt?: Date | null; // the patient answered this message (button or typed)
  replyAction?: string | null; // confirm / reschedule / cancel / rebook / book / stop …
  createdAt?: Date;
  updatedAt?: Date;
}

export type OutboxMessageDocument = HydratedDocument<IOutboxMessage>;

const OutboxSchema = new Schema<IOutboxMessage>(
  {
    patient: { type: Schema.Types.ObjectId, ref: "Patient", default: null },
    toType: { type: String, enum: ["patient", "staff", "admin"], required: true },
    toRef: { type: String, required: true },
    channel: { type: String, enum: OUTBOX_CHANNELS, required: true },
    source: { type: String, enum: OUTBOX_SOURCES, required: true },
    messageKind: { type: String, enum: ["session", "template", "sms", "inapp"], required: true },
    templateKey: { type: String, default: null },
    templateVersion: { type: Number, default: null },
    whatsappTemplateName: { type: String, default: null },
    variables: { type: Schema.Types.Mixed, default: {} },
    renderedText: { type: String, default: "", maxlength: 4096 },
    interactive: { type: Schema.Types.Mixed, default: null },
    language: { type: String, enum: ["bn", "en"], default: "bn" },
    scheduledFor: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    status: { type: String, enum: OUTBOX_STATUSES, default: "queued" },
    providerMessageId: { type: String, default: null },
    error: { type: String, default: null, maxlength: 500 },
    deliveryUpdates: {
      type: [
        new Schema<DeliveryUpdate>(
          { status: String, at: Date, error: { type: String, default: null } },
          { _id: false },
        ),
      ],
      default: [],
    },
    cost: { type: Number, default: null },
    relatedType: { type: String, default: null },
    relatedId: { type: String, default: null },
    ruleKey: { type: String, default: null },
    job: { type: Schema.Types.ObjectId, ref: "AutomationJob", default: null },
    conversation: { type: Schema.Types.ObjectId, ref: "Conversation", default: null },
    chatMessage: { type: Schema.Types.ObjectId, ref: "ChatMessage", default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    replyWindowClosesAt: { type: Date, default: null },
    payload: { type: Schema.Types.Mixed, default: null },
    retryOf: { type: Schema.Types.ObjectId, ref: "OutboxMessage", default: null },
    repliedAt: { type: Date, default: null },
    replyAction: { type: String, default: null },
  },
  { timestamps: true },
);

OutboxSchema.index({ createdAt: -1 });
OutboxSchema.index({ toRef: 1, createdAt: -1 }); // per-phone caps, dedupe, reply routing
OutboxSchema.index({ patient: 1, createdAt: -1 }); // patient "Messages" tab
OutboxSchema.index({ providerMessageId: 1 }, { sparse: true }); // delivery webhooks
OutboxSchema.index({ ruleKey: 1, createdAt: -1 });
OutboxSchema.index({ status: 1, createdAt: -1 });
OutboxSchema.index({ chatMessage: 1 }, { sparse: true });

export const OutboxMessageModel =
  mongoose.models.OutboxMessage || mongoose.model<IOutboxMessage>("OutboxMessage", OutboxSchema);
