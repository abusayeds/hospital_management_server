/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomBytes } from "crypto";
import { Types } from "mongoose";
import { ChatMessageModel } from "../../modules/assistant/chatMessage.model";
import { ConversationModel } from "../../modules/assistant/conversation.model";
import { AppointmentModel } from "../../modules/hospital/appointment/appointment.model";
import { PatientModel } from "../../modules/patients/patient.model";
import { todayInDhaka } from "../../utils/date";
import { logger } from "../../utils/logger";

/**
 * DEMO ASSISTANT CONVERSATIONS — so the staff inbox is not empty in a demo: a resolved web booking,
 * a WhatsApp patient asking for a person, an emergency, and a knowledge-base answer. All invented.
 * Also marks some upcoming bookings as made through WhatsApp. Runs once (when no conversations exist).
 */

type Line = {
  sender: "patient" | "bot" | "staff" | "system";
  text: string;
  minutes: number;
  tools?: string[];
  rich?: any;
};

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

const insertConversation = async (conv: Record<string, unknown>, lines: Line[]) => {
  const _id = new Types.ObjectId();
  const last = lines[lines.length - 1];
  const inbound = [...lines].reverse().find((l) => l.sender === "patient");
  await ConversationModel.collection.insertOne({
    _id,
    tags: [],
    notes: [],
    refs: {},
    linkedPatientIds: [],
    emergency: false,
    unreadCount: 0,
    simulated: false,
    lastOptions: [],
    runningSummary: "",
    metrics: {
      messageCount: lines.length,
      toolCallCount: lines.reduce((n, l) => n + (l.tools?.length ?? 0), 0),
      bookingsCreated: 0,
      handoverCount: 0,
    },
    lastMessageAt: at(last.minutes),
    lastInboundAt: inbound ? at(inbound.minutes) : null,
    lastPreview: last.text.slice(0, 200),
    createdAt: at(lines[0].minutes),
    updatedAt: at(last.minutes),
    ...conv,
  } as any);
  await ChatMessageModel.collection.insertMany(
    lines.map((l) => ({
      conversation: _id,
      channel: conv.channel,
      direction: l.sender === "patient" ? "inbound" : "outbound",
      sender: l.sender,
      text: l.text,
      rich: l.rich ?? null,
      replyId: null,
      toolCalls: (l.tools ?? []).map((name) => ({
        name,
        arguments: {},
        resultSummary: "ok",
        success: true,
        latencyMs: 900,
      })),
      externalMessageId: conv.channel === "whatsapp" ? `wamid.DEMO.${randomBytes(6).toString("hex")}` : null,
      deliveryStatus: conv.channel === "whatsapp" && l.sender !== "patient" ? "read" : null,
      guardFlags: [],
      createdAt: at(l.minutes),
    })) as any[],
  );
};

export const seedAssistantDemo = async () => {
  if ((await ConversationModel.estimatedDocumentCount()) > 0) return;
  const patients = await PatientModel.find().sort({ createdAt: 1 }).limit(4).lean<any[]>();
  if (patients.length < 4) return;
  const [p1, p2, p3, p4] = patients;
  const wa = (p: any) => String(p.phone).replace("+", "");

  // 1) Web chat: booking completed, resolved
  const booked = await AppointmentModel.findOne({ patient: p1._id, date: { $gte: todayInDhaka() } })
    .populate("doctor", "title name roomNo")
    .lean<any>();
  await insertConversation(
    {
      channel: "web",
      channelUserId: randomBytes(16).toString("hex"),
      phone: p1.phone,
      verifiedPhone: p1.phone,
      verifiedAt: at(180),
      linkedPatientIds: [p1._id],
      status: "resolved",
      language: "bn",
      metrics: { messageCount: 8, toolCallCount: 5, bookingsCreated: 1, handoverCount: 0 },
    },
    [
      { sender: "patient", text: "কাল মেডিসিনের ডাক্তার দেখাতে চাই", minutes: 190 },
      {
        sender: "bot",
        text: "মেডিসিন বিভাগের ডাক্তারদের তালিকা দিলাম। কাকে দেখাতে চান?",
        minutes: 189,
        tools: ["search_doctors"],
      },
      { sender: "patient", text: "সকাল ১০:২০", minutes: 186 },
      { sender: "bot", text: "সিরিয়াল নিতে আপনার মোবাইল নম্বরটি দিন।", minutes: 185, tools: ["book_appointment"] },
      { sender: "patient", text: "••••••", minutes: 182 },
      {
        sender: "bot",
        text: "✅ আপনার নম্বর যাচাই হয়েছে। কার জন্য সিরিয়াল নিতে চান?",
        minutes: 181,
        tools: ["verify_code"],
      },
      { sender: "patient", text: "✅ নিশ্চিত করুন · Confirm", minutes: 180 },
      {
        sender: "bot",
        text: booked
          ? `সিরিয়াল ${booked.serialNo} নিশ্চিত হয়েছে · Booked — ${booked.date} ${booked.slotTime}`
          : "সিরিয়াল নিশ্চিত হয়েছে · Booked",
        minutes: 180,
        tools: ["book_appointment"],
      },
    ],
  );

  // 2) WhatsApp: wants a person about a bill — waiting for staff
  await insertConversation(
    {
      channel: "whatsapp",
      channelUserId: wa(p2),
      profileName: p2.name,
      phone: p2.phone,
      verifiedPhone: p2.phone,
      verifiedAt: at(40),
      linkedPatientIds: [p2._id],
      status: "needs_human",
      handoverReason: "Patient asked for a person (billing)",
      handoverAt: at(35),
      unreadCount: 2,
      language: "bn",
      tags: ["billing"],
      metrics: { messageCount: 4, toolCallCount: 1, bookingsCreated: 0, handoverCount: 1 },
    },
    [
      { sender: "patient", text: "গতকালের টেস্টের বিলে ভুল আছে মনে হচ্ছে", minutes: 40 },
      { sender: "bot", text: "দুঃখিত, বিলের বিষয়টি আমি দেখতে পারি না। একজন স্টাফের সাথে কথা বলতে চান?", minutes: 39 },
      { sender: "patient", text: "হ্যাঁ, মানুষের সাথে কথা বলতে চাই", minutes: 36 },
      {
        sender: "system",
        text: "একজন স্টাফকে জানানো হয়েছে, শীঘ্রই এখানে উত্তর দেবেন। · A staff member will reply here soon.",
        minutes: 35,
        tools: ["request_human"],
      },
    ],
  );

  // 3) Web chat: EMERGENCY — pinned red in the inbox
  await insertConversation(
    {
      channel: "web",
      channelUserId: randomBytes(16).toString("hex"),
      status: "needs_human",
      emergency: true,
      tags: ["EMERGENCY"],
      handoverReason: "EMERGENCY: chest pain",
      handoverAt: at(12),
      unreadCount: 1,
      language: "mixed",
      metrics: { messageCount: 2, toolCallCount: 0, bookingsCreated: 0, handoverCount: 1 },
    },
    [
      { sender: "patient", text: "babar buke onek betha hocche, ghamche", minutes: 12 },
      {
        sender: "system",
        text: "⚠️ এটি জরুরি অবস্থা হতে পারে। দেরি না করে এখনই নিকটস্থ জরুরি বিভাগে যান অথবা ৯৯৯-এ ফোন করুন।",
        minutes: 12,
        rich: {
          type: "handover",
          emergency: true,
          text: "⚠️ এটি জরুরি অবস্থা হতে পারে। দেরি না করে এখনই নিকটস্থ জরুরি বিভাগে যান অথবা ৯৯৯-এ ফোন করুন।",
        },
      },
    ],
  );

  // 4) WhatsApp: answered from the knowledge base, assistant still in charge
  await insertConversation(
    {
      channel: "whatsapp",
      channelUserId: wa(p3),
      profileName: p3.name,
      phone: p3.phone,
      verifiedPhone: p3.phone,
      verifiedAt: at(90),
      linkedPatientIds: [p3._id],
      status: "bot_active",
      language: "bn",
      metrics: { messageCount: 2, toolCallCount: 1, bookingsCreated: 0, handoverCount: 0 },
    },
    [
      { sender: "patient", text: "লিপিড প্রোফাইলের আগে কি খালি পেটে থাকতে হবে?", minutes: 90 },
      {
        sender: "bot",
        text: "হ্যাঁ, লিপিড প্রোফাইলের জন্য ১০–১২ ঘণ্টা খালি পেটে থাকতে হয়; শুধু পানি খাওয়া যাবে। সকাল ১০টার আগে ল্যাবে আসুন। (সূত্র: লিপিড প্রোফাইল পরীক্ষার প্রস্তুতি)",
        minutes: 89,
        tools: ["search_knowledge_base"],
      },
    ],
  );

  // Some upcoming bookings came through WhatsApp (the dashboard's "by source" chart)
  const future = await AppointmentModel.find({
    date: { $gt: todayInDhaka() },
    status: "booked",
    patient: { $ne: p4._id },
  })
    .limit(6)
    .select("_id")
    .lean<any[]>();
  await AppointmentModel.updateMany({ _id: { $in: future.map((a) => a._id) } }, { $set: { source: "whatsapp" } });
  logger.info("Assistant demo: 4 conversations (1 emergency, 1 waiting for staff), 6 WhatsApp bookings");
};
