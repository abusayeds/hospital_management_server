import mongoose, { Document, Schema } from "mongoose";

export type TChatMessage = {
  role: "user" | "assistant";
  text: string;
  at: Date;
};

export type IChatSession = {
  sessionId: string;
  channel: "web" | "whatsapp";
  messages: TChatMessage[];
  // Emergency detected: staff must call the patient right away
  emergency: boolean;
  // Patient asked for (or AI requested) a human staff member
  needsHuman: boolean;
  handoffReason?: string;
  resolvedAt?: Date;
  appointmentIds: string[];
} & Document;

const ChatMessageSchema = new Schema<TChatMessage>(
  {
    role: { type: String, enum: ["user", "assistant"], required: true },
    text: { type: String, required: true },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const ChatSessionSchema = new Schema<IChatSession>(
  {
    sessionId: { type: String, required: true, unique: true },
    channel: { type: String, enum: ["web", "whatsapp"], default: "web" },
    messages: { type: [ChatMessageSchema], default: [] },
    emergency: { type: Boolean, default: false },
    needsHuman: { type: Boolean, default: false },
    handoffReason: { type: String },
    resolvedAt: { type: Date },
    appointmentIds: { type: [String], default: [] },
  },
  { timestamps: true },
);

export const ChatSessionModel =
  mongoose.models.ChatSession || mongoose.model<IChatSession>("ChatSession", ChatSessionSchema);
