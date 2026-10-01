/* eslint-disable @typescript-eslint/no-explicit-any */
import { Request } from "express";
import { Types } from "mongoose";
import AppError from "../../errors/AppError";
import { buildPagination } from "../../interface/global.interface";
import { ageOn, todayInDhaka } from "../../utils/date";
import { escapeRegex } from "../../utils/escapeRegex";
import { recordAudit } from "../audit/audit.service";
import { AppointmentModel } from "../hospital/appointment/appointment.model";
import { PatientModel } from "../patients/patient.model";
import type { OutboundMessage } from "./assistant.types";
import { adapterFor } from "./channels";
import "./channels/whatsapp/adapter"; // registers the WhatsApp adapter
import { ChatMessageDocument, ChatMessageModel } from "./chatMessage.model";
import { ConversationDocument, ConversationModel } from "./conversation.model";
import { notifyInbox } from "./handover";

/**
 * STAFF INBOX — every assistant conversation, live. Staff can take over (the assistant goes quiet),
 * reply through the patient's own channel, hand back to the assistant and resolve. Take-over,
 * replies, hand-back and resolve are audited.
 */

export const INBOX_FILTERS = ["needs_human", "emergency", "human_active", "bot_active", "resolved", "all"] as const;

export const CANNED_REPLIES = [
  {
    id: "greet",
    label: "Greeting",
    text: "আসসালামু আলাইকুম, আমি Testolife Hospital থেকে বলছি। কীভাবে সাহায্য করতে পারি?",
  },
  { id: "checking", label: "Checking", text: "একটু অপেক্ষা করুন, আমি বিষয়টি দেখে জানাচ্ছি।" },
  { id: "call", label: "We'll call", text: "আমরা কিছুক্ষণের মধ্যে আপনাকে ফোন করছি। অনুগ্রহ করে ফোনটি কাছে রাখুন।" },
  {
    id: "emergency",
    label: "Come to Emergency",
    text: "অনুগ্রহ করে দেরি না করে এখনই আমাদের জরুরি বিভাগে চলে আসুন অথবা ৯৯৯-এ ফোন করুন।",
  },
  {
    id: "booked",
    label: "Booked",
    text: "আপনার সিরিয়াল নিশ্চিত করা হয়েছে। নির্ধারিত সময়ের ১৫ মিনিট আগে এসে রিসেপশনে জানাবেন।",
  },
  { id: "thanks", label: "Closing", text: "ধন্যবাদ। আর কোনো প্রয়োজনে এখানে লিখবেন। সুস্থ থাকুন।" },
];

const displayName = (c: any) =>
  c.profileName ||
  (c.verifiedPhone ? c.verifiedPhone.replace("+88", "") : null) ||
  (c.channel === "web" ? `Web visitor ${String(c.channelUserId).slice(0, 4).toUpperCase()}` : c.channelUserId);

const listItem = (c: any) => ({
  id: String(c._id),
  channel: c.channel,
  displayName: displayName(c),
  verified: Boolean(c.verifiedPhone),
  status: c.status,
  emergency: c.emergency,
  tags: c.tags ?? [],
  lastPreview: c.lastPreview ?? "",
  lastMessageAt: c.lastMessageAt,
  unreadCount: c.unreadCount ?? 0,
  handoverReason: c.handoverReason ?? null,
  assignedTo: c.assignedTo?.name ? { id: String(c.assignedTo._id), name: c.assignedTo.name } : null,
  simulated: Boolean(c.simulated),
});

export const listConversations = async (f: {
  filter: (typeof INBOX_FILTERS)[number];
  channel?: string;
  q?: string;
  page: number;
  limit: number;
}) => {
  const query: Record<string, unknown> = {};
  if (f.filter === "emergency") query.emergency = true;
  else if (f.filter !== "all") query.status = f.filter;
  if (f.channel) query.channel = f.channel;
  if (f.q) {
    const rx = new RegExp(escapeRegex(f.q), "i");
    query.$or = [{ profileName: rx }, { verifiedPhone: rx }, { lastPreview: rx }, { tags: rx }];
  }
  const [items, total] = await Promise.all([
    ConversationModel.find(query)
      .sort({ emergency: -1, lastMessageAt: -1 })
      .skip((f.page - 1) * f.limit)
      .limit(f.limit)
      .populate("assignedTo", "name")
      .lean<any[]>(),
    ConversationModel.countDocuments(query),
  ]);
  return { items: items.map(listItem), pagination: buildPagination(f.page, f.limit, total) };
};

export const inboxSummary = async () => {
  const [needsHuman, emergency, humanActive] = await Promise.all([
    ConversationModel.countDocuments({ status: "needs_human" }),
    ConversationModel.countDocuments({ emergency: true, status: { $ne: "resolved" } }),
    ConversationModel.countDocuments({ status: "human_active" }),
  ]);
  return { needsHuman, emergency, humanActive, attention: needsHuman + emergency };
};

const loadConv = async (id: string) => {
  if (!Types.ObjectId.isValid(id)) throw new AppError(400, "Invalid conversation id.", "INVALID_ID");
  const c = (await ConversationModel.findById(id)) as ConversationDocument | null;
  if (!c) throw new AppError(404, "Conversation not found.");
  return c;
};

const messageView = (m: any) => ({
  id: String(m._id),
  direction: m.direction,
  sender: m.sender,
  staffName: m.staffUser?.name ?? null,
  text: m.text,
  rich: m.rich ?? null,
  toolCalls: (m.toolCalls ?? []).map((t: any) => ({
    name: t.name,
    resultSummary: t.resultSummary,
    success: t.success,
  })),
  guardFlags: m.guardFlags ?? [],
  deliveryStatus: m.deliveryStatus ?? null,
  deliveryError: m.deliveryError ?? null,
  createdAt: m.createdAt,
});

/** Transcript + context (verified phone, patients on it, upcoming appointments). Opening marks it read. */
export const getConversation = async (req: Request, id: string) => {
  const c = await loadConv(id);
  const [messages, patients] = await Promise.all([
    ChatMessageModel.find({ conversation: c._id })
      .sort({ createdAt: 1 })
      .limit(300)
      .populate("staffUser", "name")
      .lean<any[]>(),
    c.verifiedPhone ? PatientModel.find({ phone: c.verifiedPhone }).lean<any[]>() : Promise.resolve([]),
  ]);
  const appointments = patients.length
    ? await AppointmentModel.find({
        patient: { $in: patients.map((p) => p._id) },
        date: { $gte: todayInDhaka() },
        status: { $in: ["booked", "checked_in", "in_consultation"] },
      })
        .sort({ date: 1, slotTime: 1 })
        .limit(6)
        .populate("patient", "name")
        .populate("doctor", "title name")
        .lean<any[]>()
    : [];
  if (c.unreadCount) {
    c.unreadCount = 0;
    await c.save();
    notifyInbox(c);
  }
  await recordAudit({ req, action: "VIEW", entityType: "Conversation", entityId: c._id });
  const populated = await c.populate([
    { path: "assignedTo", select: "name" },
    { path: "notes.by", select: "name" },
  ]);
  return {
    conversation: {
      ...listItem(populated.toObject()),
      phone: c.verifiedPhone ?? c.phone ?? null,
      verifiedAt: c.verifiedAt ?? null,
      language: c.language,
      notes: (c.notes ?? []).map((n: any) => ({ id: String(n._id), text: n.text, byName: n.byName, at: n.at })),
      metrics: c.metrics,
      takenOverAt: c.takenOverAt ?? null,
      withinWhatsAppWindow:
        c.channel !== "whatsapp" ||
        Boolean(c.lastInboundAt && Date.now() - c.lastInboundAt.getTime() < 24 * 3600 * 1000),
    },
    messages: messages.map(messageView),
    context: {
      patients: patients.map((p) => ({
        id: String(p._id),
        name: p.name,
        patientCode: p.patientCode,
        age: ageOn(p.dateOfBirth),
        gender: p.gender,
      })),
      appointments: appointments.map((a) => ({
        id: String(a._id),
        patient: a.patient?.name,
        doctor: `${a.doctor?.title ?? ""} ${a.doctor?.name ?? ""}`.trim(),
        date: a.date,
        slotTime: a.slotTime,
        serialNo: a.serialNo,
        status: a.status,
        source: a.source,
      })),
    },
  };
};

/** Store a staff/system message and deliver it through the conversation's own channel */
const sendToPatient = async (
  c: ConversationDocument,
  message: OutboundMessage,
  fields: { sender: "staff" | "system"; staffUser?: string },
) => {
  const doc = (await ChatMessageModel.create({
    conversation: c._id,
    channel: c.channel,
    direction: "outbound",
    sender: fields.sender,
    staffUser: fields.staffUser ?? null,
    text: "text" in message ? message.text : "",
    rich: message.type === "text" ? null : message,
    deliveryStatus: c.channel === "whatsapp" ? "pending" : null,
  })) as ChatMessageDocument;
  await adapterFor(c.channel).deliver(c, [{ doc, message }]);
  c.lastMessageAt = new Date();
  c.lastPreview = ("text" in message ? message.text : "").slice(0, 200);
  c.metrics.messageCount += 1;
  return (await ChatMessageModel.findById(doc._id).populate("staffUser", "name").lean<any>()) as any;
};

const audit = (req: Request, c: ConversationDocument, event: string, meta: Record<string, unknown> = {}) =>
  recordAudit({ req, action: "UPDATE", entityType: "Conversation", entityId: c._id, meta: { event, ...meta } });

export const takeOver = async (req: Request, id: string) => {
  const c = await loadConv(id);
  const before = c.status;
  c.status = "human_active";
  c.assignedTo = new Types.ObjectId(req.user!.id);
  c.takenOverAt = new Date();
  await sendToPatient(
    c,
    { type: "handover", text: "একজন হাসপাতাল স্টাফ যুক্ত হয়েছেন। · A hospital staff member has joined the chat." },
    { sender: "system" },
  );
  await c.save();
  await audit(req, c, "takeover", { from: before });
  notifyInbox(c);
  return getConversation(req, id);
};

export const staffReply = async (req: Request, id: string, text: string) => {
  const c = await loadConv(id);
  if (c.channel === "whatsapp" && !(c.lastInboundAt && Date.now() - c.lastInboundAt.getTime() < 24 * 3600 * 1000))
    throw new AppError(
      409,
      "The patient's last WhatsApp message is older than 24 hours — WhatsApp only allows approved template messages now.",
      "CONFLICT",
    );
  if (c.status !== "human_active") {
    // Replying means taking over: the assistant must not talk over a human
    c.status = "human_active";
    c.assignedTo = new Types.ObjectId(req.user!.id);
    c.takenOverAt = new Date();
  }
  const msg = await sendToPatient(c, { type: "text", text }, { sender: "staff", staffUser: req.user!.id });
  c.lastStaffReplyAt = new Date();
  await c.save();
  await audit(req, c, "staff_reply", { messageId: msg._id, length: text.length });
  notifyInbox(c);
  if (msg.deliveryStatus === "failed")
    throw new AppError(502, `Saved, but WhatsApp did not accept it: ${msg.deliveryError}`, "BAD_REQUEST");
  return messageView(msg);
};

export const handBack = async (req: Request, id: string) => {
  const c = await loadConv(id);
  c.status = "bot_active";
  c.assignedTo = null;
  await sendToPatient(
    c,
    { type: "text", text: "আপনি আবার Testo Life Assistant-এর সাথে আছেন। · You're back with the Testo Life Assistant." },
    { sender: "system" },
  );
  await c.save();
  await audit(req, c, "hand_back");
  notifyInbox(c);
  return getConversation(req, id);
};

export const resolve = async (req: Request, id: string) => {
  const c = await loadConv(id);
  c.status = "resolved";
  c.emergency = false; // stays tagged EMERGENCY for the record, but no longer pinned
  c.assignedTo = null;
  c.unreadCount = 0;
  await c.save();
  await audit(req, c, "resolve");
  notifyInbox(c);
  return getConversation(req, id);
};

export const setTags = async (req: Request, id: string, tags: string[]) => {
  const c = await loadConv(id);
  c.tags = [...new Set(tags.map((t) => t.trim()).filter(Boolean))].slice(0, 12);
  await c.save();
  await audit(req, c, "tags", { tags: c.tags });
  notifyInbox(c);
  return c.tags;
};

export const addNote = async (req: Request, id: string, text: string) => {
  const c = await loadConv(id);
  c.notes.push({ text, by: new Types.ObjectId(req.user!.id), byName: req.user!.name, at: new Date() });
  await c.save();
  await audit(req, c, "note");
  return c.notes.map((n: any) => ({ id: String(n._id), text: n.text, byName: n.byName, at: n.at }));
};
