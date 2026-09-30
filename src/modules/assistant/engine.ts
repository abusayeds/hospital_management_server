/* eslint-disable @typescript-eslint/no-explicit-any */
import { chatRound, generateStructured } from "../../ai/ai.service";
import { ASSISTANT_PROMPT_VERSION, buildAssistantSystemPrompt } from "../../ai/prompts/assistant.v1";
import type { AiTurn } from "../../ai/provider";
import { publish } from "../../events/bus";
import { DAY_NAMES_EN, todayInDhaka, weekdayOf } from "../../utils/date";
import { logger } from "../../utils/logger";
import { toE164Bd } from "../../utils/phone";
import { getSettings } from "../hospital/settings/settings.service";
import { PatientModel } from "../patients/patient.model";
import { InboundMessage, messageText, OutboundMessage } from "./assistant.types";
import { ChatMessageDocument, ChatMessageModel, ToolCallLog } from "./chatMessage.model";
import { ConversationDocument, ConversationModel } from "./conversation.model";
import { notifyInbox, requestHandover } from "./handover";
import { describeReply, handleInteraction, MENU_OPTIONS } from "./interactions";
import { refFor } from "./refs";
import { guardOutput, preChecks } from "./safety";
import { runTool, toolDefinitions } from "./tools";
import type { ToolContext } from "./tools/types";
import { z } from "zod";

/**
 * CONVERSATION ENGINE — channel-independent. Every channel adapter calls handleInbound() with a
 * normalised message and renders the OutboundMessages it gets back.
 *
 *  1. idempotency (a provider message id is processed once) → load/create the conversation
 *  2. store the inbound message, notify the staff inbox
 *  3. staff took over?  → stay silent
 *  4. safety pre-checks (limits, emergency) → may answer immediately without the AI
 *  5. deterministic taps (Confirm, OTP, menu) → handled in code
 *  6. AI loop: model ↔ tools, max MAX_TOOL_ROUNDS rounds
 *  7. output guard → store replies → inbox update
 * If the AI fails the patient ALWAYS gets a friendly fallback with the hospital phone and a
 * "talk to a person" option — the assistant never goes silent.
 */

export const MAX_TOOL_ROUNDS = 5;
const MEMORY_MESSAGES = 12;
const SUMMARY_EVERY = 20;

export type EngineResult = {
  conversation: ConversationDocument;
  messages: OutboundMessage[];
  stored: ChatMessageDocument[];
  duplicate?: boolean;
};

// ------------------------------------------------------------------ helpers

/** Bangla script → bn · Latin with common Banglish words → mixed · otherwise en */
export const detectLanguage = (text: string): "bn" | "en" | "mixed" => {
  if (/[ঀ-৿]/.test(text)) return "bn";
  if (
    /\b(ami|apni|amar|kal|aj|ache|nai|chai|koto|kobe|kothay|doctor\s*dekhabo|serial|bhai|apa|hobe|korte|dekhte)\b/i.test(
      text,
    )
  )
    return "mixed";
  return "en";
};

const loadConversation = async (inbound: InboundMessage) => {
  const conv = (await ConversationModel.findOneAndUpdate(
    { channel: inbound.channel, channelUserId: inbound.channelUserId },
    { $setOnInsert: { channel: inbound.channel, channelUserId: inbound.channelUserId, status: "bot_active" } },
    { upsert: true, new: true },
  )) as ConversationDocument;
  // WhatsApp: the sender's own number is verified by WhatsApp itself (only that number)
  if (inbound.channel === "whatsapp" && !conv.verifiedPhone) {
    const phone = toE164Bd(inbound.channelUserId);
    if (phone) {
      conv.phone = phone;
      conv.verifiedPhone = phone;
      conv.verifiedAt = new Date();
      conv.linkedPatientIds = (await PatientModel.find({ phone }).select("_id").lean<any[]>()).map((p) => p._id);
    }
  }
  if (inbound.profileName) conv.profileName = inbound.profileName.slice(0, 100);
  if (conv.status === "resolved") conv.status = "bot_active"; // a new message re-opens it
  return conv;
};

const storeMessage = (conv: ConversationDocument, fields: Record<string, unknown>) =>
  ChatMessageModel.create({ conversation: conv._id, channel: conv.channel, ...fields }) as Promise<ChatMessageDocument>;

/** Who the model is talking to — verification state and short references only (no phone, no ids) */
const identityLine = async (conv: ConversationDocument) => {
  if (!conv.verifiedPhone) return "Phone NOT verified. Personal actions need start_verification first.";
  const patients = await PatientModel.find({ _id: { $in: conv.linkedPatientIds } })
    .select("name gender dateOfBirth")
    .lean<any[]>();
  const list = patients.map(
    (p) => `${refFor(conv, "P", String(p._id))} (${String(p.name).split(" ")[0]}, ${p.gender})`,
  );
  return `Phone verified (ends with ${conv.verifiedPhone.slice(-2)}). Patients on this phone: ${list.join(", ") || "none yet (use register_patient)"}.`;
};

/** Last messages as model turns (text only; staff replies are marked so the model knows) */
const memoryTurns = async (conv: ConversationDocument, excludeId: unknown): Promise<AiTurn[]> => {
  const recent = await ChatMessageModel.find({ conversation: conv._id, _id: { $ne: excludeId } })
    .sort({ createdAt: -1 })
    .limit(MEMORY_MESSAGES)
    .lean<any[]>();
  const turns: AiTurn[] = [];
  for (const m of recent.reverse()) {
    const role = m.sender === "patient" ? "user" : "model";
    // A tapped button is remembered by its meaning (ids, times), not only by its label
    const text =
      m.sender === "staff"
        ? `[Hospital staff replied]: ${m.text}`
        : m.sender === "patient" && m.replyId
          ? describeReply(m.replyId, m.text)
          : m.text;
    if (!text) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === role && "text" in last) last.text = `${last.text}\n${text}`;
    else turns.push(role === "user" ? { role: "user", text } : { role: "model", text });
  }
  while (turns.length && turns[0].role !== "user") turns.shift(); // must start with the patient
  return turns;
};

const fallbackMessages = async (): Promise<OutboundMessage[]> => {
  const s = await getSettings();
  const phone = s.phones?.[0] ?? s.emergencyPhone;
  return [
    {
      type: "quick_replies",
      text:
        `দুঃখিত, এই মুহূর্তে উত্তর দিতে পারছি না। অনুগ্রহ করে একটু পরে চেষ্টা করুন অথবা ফোন করুন ${phone}।\n` +
        `Sorry, I can't answer right now. Please try again shortly or call ${phone}.`,
      options: [{ id: "menu|human", label: "মানুষের সাথে কথা বলুন · Talk to a person" }],
    },
  ];
};

/** Keep only the last UI message of each kind (e.g. a new slot list replaces an older one) */
const dedupeUi = (ui: OutboundMessage[]) => {
  const keyOf = (m: OutboundMessage) => `${m.type}:${"kind" in m ? m.kind : ""}`;
  const seen = new Set<string>();
  return ui
    .reverse()
    .filter((m) => (seen.has(keyOf(m)) ? false : (seen.add(keyOf(m)), true)))
    .reverse();
};

// ------------------------------------------------------------------ AI loop

type AiOutcome = { messages: OutboundMessage[]; toolLogs: ToolCallLog[]; model?: string; flags: string[] };

const runAssistant = async (conv: ConversationDocument, userText: string, inboundId: unknown): Promise<AiOutcome> => {
  const s = await getSettings();
  const today = todayInDhaka();
  const system = buildAssistantSystemPrompt({
    hospitalName: s.name,
    hospitalNameBn: s.nameBn,
    today,
    weekday: DAY_NAMES_EN[weekdayOf(today)],
    emergencyPhone: s.emergencyPhone,
    hospitalPhone: s.phones?.[0] ?? s.emergencyPhone,
    identity: await identityLine(conv),
    summary: conv.runningSummary || undefined,
  });
  const turns: AiTurn[] = [...(await memoryTurns(conv, inboundId)), { role: "user", text: userText }];
  const ctx: ToolContext = { conversation: conv, ui: [], bookedAppointmentIds: [] };
  const toolLogs: ToolCallLog[] = [];
  const logCtx = { feature: "assistant", promptVersion: ASSISTANT_PROMPT_VERSION, entityId: String(conv._id) };
  let model: string | undefined;

  for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
    const res = await chatRound(
      { system, turns, tools: toolDefinitions(), maxOutputTokens: 600, temperature: 0.3 },
      logCtx,
    );
    model = res.model;
    if (!res.toolCalls.length) {
      const guarded = guardOutput(res.text, conv);
      const text: OutboundMessage[] = guarded.text ? [{ type: "text", text: guarded.text }] : [];
      return { messages: [...text, ...dedupeUi(ctx.ui)], toolLogs, model, flags: guarded.flags };
    }
    turns.push({ role: "model", toolCalls: res.toolCalls, raw: res.raw });
    const results = [];
    for (const call of res.toolCalls) {
      const { result, log } = await runTool(call, ctx);
      toolLogs.push(log);
      results.push({ id: call.id, name: call.name, result });
    }
    turns.push({ role: "tool", results });
  }

  // Too many rounds: stop politely and ask a human to look
  logger.warn({ conversationId: String(conv._id) }, "Assistant hit the tool-round limit");
  await requestHandover(conv, "Assistant could not finish the request");
  return {
    messages: [
      ...dedupeUi(ctx.ui),
      {
        type: "handover",
        text: "দুঃখিত, বিষয়টি একজন স্টাফকে জানিয়েছি, শীঘ্রই উত্তর দেবেন। · I've asked a staff member to help you.",
      },
    ],
    toolLogs,
    model,
    flags: ["tool_round_limit"],
  };
};

/** Every SUMMARY_EVERY messages the older part of the chat is condensed (keeps the prompt small) */
const refreshSummary = async (conv: ConversationDocument) => {
  const older = await ChatMessageModel.find({ conversation: conv._id })
    .sort({ createdAt: -1 })
    .skip(MEMORY_MESSAGES)
    .limit(40)
    .lean<any[]>();
  if (!older.length) return;
  try {
    const res = await generateStructured({
      prompt: {
        id: "assistant-summary",
        version: "assistant-summary.v1",
        system:
          "Summarise this hospital chat for the assistant in at most 5 short lines: what the patient wants, what was done " +
          '(bookings, verification), open questions. No phone numbers. Answer as JSON {"summary": string}.',
        build: (lines: string[]) => lines.join("\n"),
        maxOutputTokens: 300,
      },
      input: older.reverse().map((m) => `${m.sender}: ${m.text}`),
      schema: z.object({ summary: z.string().max(1500) }),
      entityId: String(conv._id),
    });
    await ConversationModel.updateOne({ _id: conv._id }, { $set: { runningSummary: res.data.summary } });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Conversation summary skipped");
  }
};

// ------------------------------------------------------------------ entry point

export const handleInbound = async (inbound: InboundMessage): Promise<EngineResult> => {
  const channel = inbound.channel;
  if (
    inbound.externalMessageId &&
    (await ChatMessageModel.exists({ channel, externalMessageId: inbound.externalMessageId }))
  )
    return { duplicate: true, conversation: null as never, messages: [], stored: [] };

  const conv = await loadConversation(inbound);
  const text = (inbound.text ?? "").trim().slice(0, 2000);
  const shown = text || (inbound.replyId ? describeReply(inbound.replyId) : "");
  const forModel = inbound.replyId ? describeReply(inbound.replyId, text) : text;

  let inboundDoc: ChatMessageDocument;
  try {
    inboundDoc = await storeMessage(conv, {
      direction: "inbound",
      sender: "patient",
      text: shown || `[${inbound.unsupported ?? "empty"} message]`,
      replyId: inbound.replyId ?? null,
      externalMessageId: inbound.externalMessageId ?? null,
    });
  } catch (err) {
    // Two deliveries of the same provider message raced: the unique index let only one through
    if ((err as { code?: number }).code === 11000)
      return { duplicate: true, conversation: conv, messages: [], stored: [] };
    throw err;
  }
  const isFirst = conv.metrics.messageCount === 0;
  conv.lastMessageAt = new Date();
  conv.lastInboundAt = new Date();
  conv.lastPreview = shown.slice(0, 200);
  conv.unreadCount += 1;
  conv.metrics.messageCount += 1;
  if (text) conv.language = detectLanguage(text);
  await conv.save();
  void publish("chat.message_received", { conversationId: String(conv._id), channel });
  notifyInbox(conv);

  // A staff member is handling it: the assistant stays quiet
  if (conv.status === "human_active") return { conversation: conv, messages: [], stored: [] };

  const started = Date.now();
  let outcome: AiOutcome;
  if (inbound.unsupported) {
    outcome = {
      messages: [
        {
          type: "quick_replies",
          text:
            "দুঃখিত, এখন শুধু লেখা বার্তা বুঝতে পারি। লিখে জানান, অথবা একজন স্টাফের সাথে কথা বলুন।\n" +
            "Sorry, I can only read text messages for now.",
          options: [{ id: "menu|human", label: "মানুষের সাথে কথা বলুন · Talk to a person" }],
        },
      ],
      toolLogs: [],
      flags: [],
    };
  } else {
    const pre = await preChecks(conv, text);
    const tapped = pre ? null : await handleInteraction(conv, inbound.replyId, text);
    if (pre) outcome = { messages: pre.messages, toolLogs: [], flags: ["pre_check"] };
    else if (tapped) outcome = { messages: tapped.messages, toolLogs: [], flags: [] };
    else if (inbound.replyId === "menu|human") {
      await requestHandover(conv, "Patient asked for a person");
      outcome = {
        messages: [
          {
            type: "handover",
            text: "একজন স্টাফকে জানানো হয়েছে, শীঘ্রই এখানে উত্তর দেবেন। · A staff member will reply here soon.",
          },
        ],
        toolLogs: [],
        flags: [],
      };
    } else {
      try {
        outcome = await runAssistant(conv, forModel, inboundDoc._id);
      } catch (err) {
        logger.warn({ err: (err as Error).message, conversationId: String(conv._id) }, "Assistant fallback used");
        outcome = { messages: await fallbackMessages(), toolLogs: [], flags: ["ai_failure"] };
      }
      if (!outcome.messages.length) outcome.messages = await fallbackMessages();
    }
  }
  if (isFirst && !outcome.messages.some((m) => m.type === "quick_replies" || m.type === "list"))
    outcome.messages.push({
      type: "quick_replies",
      text: "আর কীভাবে সাহায্য করতে পারি? · How else can I help?",
      options: MENU_OPTIONS,
    });

  // Store the replies (tool calls travel with the first one)
  const latencyMs = Date.now() - started;
  const stored: ChatMessageDocument[] = [];
  for (const [i, m] of outcome.messages.entries()) {
    stored.push(
      await storeMessage(conv, {
        direction: "outbound",
        sender: m.type === "handover" ? "system" : "bot",
        text: messageText(m),
        rich: m.type === "text" ? null : m,
        toolCalls: i === 0 ? outcome.toolLogs : [],
        latencyMs: i === 0 ? latencyMs : null,
        model: outcome.model ?? null,
        guardFlags: i === 0 ? outcome.flags : [],
        deliveryStatus: channel === "whatsapp" ? "pending" : null,
      }),
    );
  }

  // Tools changed this same document (references, handover, pending action): save it once more
  const fresh = conv;
  fresh.metrics.messageCount += outcome.messages.length;
  fresh.metrics.toolCallCount += outcome.toolLogs.length;
  fresh.lastMessageAt = new Date();
  if (outcome.messages.length)
    fresh.lastPreview = messageText(outcome.messages[outcome.messages.length - 1]).slice(0, 200);
  await fresh.save();
  notifyInbox(fresh);
  if (
    fresh.metrics.messageCount % SUMMARY_EVERY < outcome.messages.length + 1 &&
    fresh.metrics.messageCount > SUMMARY_EVERY
  )
    void refreshSummary(fresh);

  return { conversation: fresh, messages: outcome.messages, stored };
};
