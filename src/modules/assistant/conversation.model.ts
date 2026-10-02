import mongoose, { HydratedDocument, Schema, Types } from "mongoose";
import { CHANNELS, Channel } from "./assistant.types";

/**
 * CONVERSATION — one per patient per channel (a web browser session or a WhatsApp number).
 *
 * status:
 *   bot_active   → the assistant answers
 *   needs_human  → the assistant still answers, but staff are asked to look (emergency, request, failure)
 *   human_active → a staff member took over: the assistant is SILENT until handed back
 *   resolved     → closed by staff (a new message re-opens it as bot_active)
 *
 * Identity: `verifiedPhone` is set only by an OTP (web) or by WhatsApp itself (the sender's number).
 * Every personal tool call is authorised against it in code — never against what the model says.
 */
export const CONVERSATION_STATUSES = ["bot_active", "needs_human", "human_active", "resolved"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

/** A booking / cancellation / reschedule waiting for the patient's explicit Confirm */
export type PendingAction = {
  id: string;
  type: "book" | "cancel" | "reschedule";
  payload: Record<string, unknown>;
  expiresAt: Date;
};

export interface IConversation {
  channel: Channel;
  channelUserId: string;
  profileName?: string | null;
  phone?: string | null; // +8801… when known
  verifiedPhone?: string | null;
  verifiedAt?: Date | null;
  linkedPatientIds: Types.ObjectId[];
  chatAppointmentIds: Types.ObjectId[]; // booked in this chat (web chats may only see/change these)
  // Short references the model uses instead of real ids ("P1" → patient id, "A2" → appointment id)
  refs: Map<string, string>;
  language: "bn" | "en" | "mixed";
  status: ConversationStatus;
  assignedTo?: Types.ObjectId | null;
  tags: string[];
  emergency: boolean;
  handoverReason?: string | null;
  handoverAt?: Date | null;
  takenOverAt?: Date | null;
  lastStaffReplyAt?: Date | null;
  remindedAt?: Date | null; // last "patient is waiting" reminder to staff
  notes: { text: string; by: Types.ObjectId; byName: string; at: Date }[];
  pendingAction?: PendingAction | null;
  lastMessageAt: Date;
  lastInboundAt?: Date | null; // WhatsApp 24-hour customer service window starts here
  lastPreview?: string;
  unreadCount: number; // inbound messages staff have not opened yet
  runningSummary?: string;
  lastOptions: { n: number; id: string; label: string }[]; // numbered-text fallback ("reply 2") on WhatsApp
  metrics: { messageCount: number; toolCallCount: number; bookingsCreated: number; handoverCount: number };
  createdAt?: Date;
  updatedAt?: Date;
}

export type ConversationDocument = HydratedDocument<IConversation>;

const ConversationSchema = new Schema<IConversation>(
  {
    channel: { type: String, enum: CHANNELS, required: true },
    channelUserId: { type: String, required: true, maxlength: 100 },
    profileName: { type: String, default: null, maxlength: 100 },
    phone: { type: String, default: null },
    verifiedPhone: { type: String, default: null },
    verifiedAt: { type: Date, default: null },
    linkedPatientIds: { type: [Schema.Types.ObjectId], ref: "Patient", default: [] },
    chatAppointmentIds: { type: [Schema.Types.ObjectId], ref: "Appointment", default: [] },
    refs: { type: Map, of: String, default: {} },
    language: { type: String, enum: ["bn", "en", "mixed"], default: "bn" },
    status: { type: String, enum: CONVERSATION_STATUSES, default: "bot_active" },
    assignedTo: { type: Schema.Types.ObjectId, ref: "User", default: null },
    tags: { type: [String], default: [] },
    emergency: { type: Boolean, default: false },
    handoverReason: { type: String, default: null, maxlength: 300 },
    handoverAt: { type: Date, default: null },
    takenOverAt: { type: Date, default: null },
    lastStaffReplyAt: { type: Date, default: null },
    remindedAt: { type: Date, default: null },
    notes: {
      type: [
        new Schema(
          {
            text: { type: String, required: true, maxlength: 1000 },
            by: { type: Schema.Types.ObjectId, ref: "User", required: true },
            byName: String,
            at: { type: Date, required: true },
          },
          { _id: true },
        ),
      ],
      default: [],
    },
    pendingAction: { type: Schema.Types.Mixed, default: null },
    lastMessageAt: { type: Date, default: () => new Date() },
    lastInboundAt: { type: Date, default: null },
    lastPreview: { type: String, maxlength: 200, default: "" },
    unreadCount: { type: Number, default: 0 },
    runningSummary: { type: String, maxlength: 2000, default: "" },
    lastOptions: { type: [{ n: Number, id: String, label: String, _id: false }], default: [] },
    metrics: {
      messageCount: { type: Number, default: 0 },
      toolCallCount: { type: Number, default: 0 },
      bookingsCreated: { type: Number, default: 0 },
      handoverCount: { type: Number, default: 0 },
    },
  },
  { timestamps: true },
);

ConversationSchema.index({ channel: 1, channelUserId: 1 }, { unique: true });
// Inbox: emergencies first, then most recent
ConversationSchema.index({ status: 1, emergency: -1, lastMessageAt: -1 });
ConversationSchema.index({ verifiedPhone: 1 });

export const ConversationModel =
  mongoose.models.Conversation || mongoose.model<IConversation>("Conversation", ConversationSchema);
