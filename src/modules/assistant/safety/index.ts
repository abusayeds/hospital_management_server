import { aiCallsToday } from "../../../ai/ai.service";
import { startOfDhakaDay, todayInDhaka } from "../../../utils/date";
import { logger } from "../../../utils/logger";
import { getSettings } from "../../hospital/settings/settings.service";
import { PatientModel } from "../../patients/patient.model";
import type { OutboundMessage } from "../assistant.types";
import { ChatMessageModel } from "../chatMessage.model";
import type { ConversationDocument } from "../conversation.model";
import { requestHandover } from "../handover";
import { detectEmergency } from "./emergency.rules";

/**
 * SAFETY LAYER — rules in code that run around the model. The system prompt asks the model to
 * behave; these checks make sure it cannot matter if it does not:
 *   preChecks  (before the model): limits & budget → emergency → prompt injection
 *   guardOutput (after the model): dosage-like text, foreign phone numbers / patient codes, ids
 */

export const LIMITS = {
  perMinute: 12, // messages per conversation per minute
  perDay: 150, // messages per channel user per day
  maxChars: 1000, // longer messages are cut (the web route already refuses them)
};

export type PreCheckResult = { stop: true; messages: OutboundMessage[]; flag: string } | null;

// ------------------------------------------------------------------ emergency

export const emergencyMessages = async (selfHarm: boolean): Promise<OutboundMessage[]> => {
  const s = await getSettings();
  const numbers = s.emergencyPhone === "999" ? "999" : `${s.emergencyPhone} / 999`;
  if (selfHarm)
    return [
      {
        type: "handover",
        emergency: true,
        text:
          "আপনি যা অনুভব করছেন তা শুনে আমরা খুব চিন্তিত। আপনি একা নন। এখনই বিশ্বাসের কারো সাথে কথা বলুন, " +
          `অথবা ${s.emergencyPhone} / ৯৯৯ নম্বরে ফোন করুন বা আমাদের জরুরি বিভাগে চলে আসুন। আমাদের একজন কর্মী এখনই আপনার সাথে যোগাযোগ করবেন।\n\n` +
          "We are really sorry you are feeling this way. You are not alone. Please talk to someone you trust right now, " +
          `call ${numbers}, or come to our Emergency department. A staff member will reach out to you now.`,
      },
    ];
  return [
    {
      type: "handover",
      emergency: true,
      text:
        "⚠️ এটি জরুরি অবস্থা হতে পারে। দেরি না করে এখনই নিকটস্থ জরুরি বিভাগে যান, " +
        `অথবা আমাদের জরুরি নম্বর ${s.emergencyPhone} / জাতীয় জরুরি সেবা ৯৯৯-এ ফোন করুন।\n` +
        `ঠিকানা: ${s.addressBn || s.address}\n\n` +
        `⚠️ This may be an emergency. Go to the nearest emergency department now, or call our emergency line ${s.emergencyPhone} ` +
        "or 999 (Bangladesh national emergency). A staff member has been alerted.",
    },
  ];
};

// ------------------------------------------------------------------ prompt injection

/**
 * Attempts to take over the assistant. They are refused in code (the model is not called), so a
 * clever phrasing can never talk it into leaking data or skipping verification.
 */
const INJECTION = [
  /ignore\s+(all\s+|your\s+|the\s+)?(previous|prior|above|earlier)?\s*(instructions|rules|prompt)/i,
  /(reveal|show|print|repeat|tell\s+me)\s+(your|the)\s+(system\s+)?(prompt|instructions|rules)/i,
  /system\s*prompt/i,
  /you\s+are\s+now\s+(an?\s+)?(admin|administrator|developer|staff|doctor|root|dan)/i,
  /(developer|admin|god|jailbreak)\s*mode/i,
  /(list|show|give|dump)\s+(me\s+)?(all|every|other)\s+(patients|users|appointments|records|phone)/i,
  /(skip|bypass|disable)\s+(the\s+)?(verification|otp|security|rules)/i,
  /(নির্দেশ|নিয়ম)\s*(ভুলে|উপেক্ষা)/,
  /সব\s*রোগীর\s*(তালিকা|নাম|নম্বর|তথ্য)/,
];

export const isInjectionAttempt = (text: string) => INJECTION.some((rx) => rx.test(text));

const injectionReply: OutboundMessage = {
  type: "text",
  text:
    "দুঃখিত, আমি শুধু আপনার নিজের অ্যাপয়েন্টমেন্ট ও হাসপাতালের তথ্যে সাহায্য করতে পারি। অন্য কারো তথ্য দেওয়া বা নিয়ম বদলানো সম্ভব নয়।\n" +
    "Sorry, I can only help with your own appointments and hospital information. I can't share other people's data or change how I work.",
};

// ------------------------------------------------------------------ limits & budget

const busyReply = async (): Promise<OutboundMessage[]> => {
  const s = await getSettings();
  return [
    {
      type: "quick_replies",
      text:
        `এই মুহূর্তে অনেক বার্তা আসছে। অনুগ্রহ করে একটু পরে লিখুন অথবা ফোন করুন ${s.phones?.[0] ?? s.emergencyPhone}।\n` +
        "We're receiving too many messages right now. Please try again shortly or call us.",
      options: [{ id: "menu|human", label: "মানুষের সাথে কথা বলুন · Talk to a person" }],
    },
  ];
};

export const preChecks = async (conv: ConversationDocument, text: string): Promise<PreCheckResult> => {
  const s = await getSettings();

  // 1) Emergency first — it must never be blocked by a limit
  const emergency = detectEmergency(text, s.assistantEmergencyKeywords ?? []);
  if (emergency) {
    await requestHandover(conv, `EMERGENCY: ${emergency.label}`, { emergency: true });
    logger.warn({ conversationId: String(conv._id), label: emergency.label }, "Assistant emergency detected");
    return { stop: true, messages: await emergencyMessages(Boolean(emergency.selfHarm)), flag: "emergency" };
  }

  // 2) Per-conversation rate, per-user daily cap, global daily AI budget
  const minuteAgo = new Date(Date.now() - 60_000);
  const inbound = { conversation: conv._id, direction: "inbound" };
  const [lastMinute, today, aiToday] = await Promise.all([
    ChatMessageModel.countDocuments({ ...inbound, createdAt: { $gte: minuteAgo } }),
    ChatMessageModel.countDocuments({ ...inbound, createdAt: { $gte: startOfDhakaDay(todayInDhaka()) } }),
    aiCallsToday("assistant", startOfDhakaDay(todayInDhaka())),
  ]);
  if (lastMinute > LIMITS.perMinute || today > LIMITS.perDay)
    return { stop: true, messages: await busyReply(), flag: "rate_limited" };
  if (aiToday >= (s.assistantDailyAiBudget ?? 3000)) {
    logger.warn("Assistant daily AI budget reached");
    return { stop: true, messages: await busyReply(), flag: "budget_exceeded" };
  }

  // 3) Prompt injection
  if (isInjectionAttempt(text)) {
    logger.warn({ conversationId: String(conv._id) }, "Prompt-injection attempt refused");
    return { stop: true, messages: [injectionReply], flag: "injection_refused" };
  }
  return null;
};

// ------------------------------------------------------------------ output guard

const DOSAGE = [
  /\b\d+(\.\d+)?\s?(mg|mcg|µg|ml|gm|iu)\b/i,
  /\b[0-2½]\s*\+\s*[0-2½]\s*\+\s*[0-2½]\b/, // 1+0+1
  /(once|twice|thrice|\d\s*times)\s+(a|per)\s+day/i,
  /দিনে\s*[০-৯\d]+\s*(বার|টা)/,
  /\b(take|খাবেন|খান)\b.{0,30}\b(tablet|capsule|syrup|ট্যাবলেট|ক্যাপসুল|সিরাপ)/i,
];
const PHONE = /(?:\+?88)?01[3-9]\d{2}[-\s]?\d{6}\b/g;
const PATIENT_CODE = /\bTL-?\d{3,}\b/gi;
const OBJECT_ID = /\b[a-f\d]{24}\b/gi;

const safeMedicineReply =
  "দুঃখিত, ওষুধ বা ডোজ নিয়ে আমি পরামর্শ দিতে পারি না — ডাক্তার দেখে ঠিক করবেন। সিরিয়াল নিয়ে দেব?\n" +
  "Sorry, I can't advise on medicines or doses — a doctor will decide. Shall I book an appointment?";

/**
 * Checked on every model answer before it is sent. Dosage-like advice replaces the whole answer;
 * phone numbers and patient codes that do not belong to this user or the hospital are masked;
 * internal ids are removed. Findings are stored on the message (guardFlags) and logged.
 */
export const guardOutput = async (text: string, conv: ConversationDocument) => {
  const flags: string[] = [];
  if (!text) return { text, flags };
  if (DOSAGE.some((rx) => rx.test(text))) {
    logger.warn({ conversationId: String(conv._id) }, "Output guard: dosage-like content replaced");
    return { text: safeMedicineReply, flags: ["dosage_pattern"] };
  }

  const s = await getSettings();
  const digits = (p: string) => p.replace(/\D/g, "").slice(-10);
  const allowedPhones = new Set([...(s.phones ?? []), s.emergencyPhone, conv.verifiedPhone ?? ""].map(digits));
  let out = text.replace(PHONE, (m) => {
    if (allowedPhones.has(digits(m))) return m;
    flags.push("foreign_phone");
    return "[number hidden]";
  });

  if (out.match(PATIENT_CODE)) {
    const own = await PatientModel.find({ _id: { $in: conv.linkedPatientIds } })
      .select("patientCode")
      .lean<{ patientCode: string }[]>();
    const ownCodes = new Set(own.map((p) => p.patientCode.toUpperCase()));
    out = out.replace(PATIENT_CODE, (m) => {
      if (ownCodes.has(m.toUpperCase().replace(/^TL-?/, "TL-"))) return m;
      flags.push("foreign_patient_code");
      return "[code hidden]";
    });
  }
  if (out.match(OBJECT_ID)) {
    flags.push("internal_id");
    out = out.replace(OBJECT_ID, "").replace(/\s{2,}/g, " ");
  }
  if (flags.length) logger.warn({ conversationId: String(conv._id), flags }, "Output guard changed a reply");
  return { text: out, flags };
};
