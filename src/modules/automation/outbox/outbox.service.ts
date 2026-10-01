/* eslint-disable @typescript-eslint/no-explicit-any */
import { Types } from "mongoose";
import type { Permission } from "../../../config/permissions";
import { emitToPermission } from "../../../sockets";
import type { OutboundMessage } from "../../assistant/assistant.types";
import { ChatMessageModel } from "../../assistant/chatMessage.model";
import { ConversationModel } from "../../assistant/conversation.model";
import { isWhatsAppConfigured, toPayload, transportFor } from "../../assistant/channels/whatsapp/client";
import { renderForWhatsApp } from "../../assistant/channels/whatsapp/render";
import { getSettings } from "../../hospital/settings/settings.service";
import { PatientModel } from "../../patients/patient.model";
import { OutboxButton, OutboxMessageDocument, OutboxMessageModel, OutboxSource } from "../models/outbox.model";
import { smsProvider } from "./sms";

/**
 * OUTBOX SERVICE — the ONLY way automation (and admin test sends) reach a patient.
 *
 * Channel order comes from the rule (default WhatsApp → SMS). For WhatsApp:
 *   inside the 24-hour customer-service window → a normal session message (text + reply buttons)
 *   outside it → only the Meta-approved TEMPLATE (name + language + {{1}}, {{2}} parameters)
 * The message is also stored in the patient's WhatsApp conversation, so a reply ("Confirm", "STOP",
 * free text) lands in the SAME conversation the chatbot already knows.
 * Every message is sent for real; delivered / read come back from Meta's status webhook.
 */

const WINDOW_MS = 24 * 60 * 60 * 1000;

export type TemplateRef = {
  key: string;
  version: number;
  whatsappTemplateName?: string | null;
  whatsappLanguage: string;
  whatsappParams: string[];
};

export type PatientSend = {
  toType?: "patient" | "staff"; // staff = WhatsApp copy of an alert to on-call staff
  patientId?: string | null;
  phone: string; // +8801…
  language: "bn" | "en";
  text: string;
  buttons: OutboxButton[]; // ids are the reply ids the patient's tap will carry
  template?: TemplateRef | null;
  variables?: Record<string, string>;
  params?: string[]; // values for the WhatsApp template parameters, in order
  channels: ("whatsapp" | "sms")[];
  source: OutboxSource;
  ruleKey?: string | null;
  jobId?: unknown;
  related?: { type: string; id: string } | null;
  createdBy?: string | null;
  scheduledFor?: Date | null;
  retryOf?: unknown;
};

export type SendOutcome = {
  outbox: OutboxMessageDocument; // the row that finally went out (or the last failure)
  attempts: { channel: string; result: "sent" | "failed"; error?: string | null }[];
};

// ------------------------------------------------------------------ WhatsApp

/** The patient's WhatsApp conversation (created on first contact, already verified: we chose the number) */
const conversationFor = async (phone: string) => {
  const channelUserId = phone.replace(/^\+/, "");
  const linked = (await PatientModel.find({ phone }).select("_id").lean<any[]>()).map((p) => p._id);
  return (await ConversationModel.findOneAndUpdate(
    { channel: "whatsapp", channelUserId },
    {
      $setOnInsert: {
        channel: "whatsapp",
        channelUserId,
        status: "bot_active",
        phone,
        verifiedPhone: phone,
        verifiedAt: new Date(),
        linkedPatientIds: linked,
      },
    },
    { upsert: true, new: true },
  )) as any;
};

/** Approved template message (outside the 24-hour window). Reply buttons carry our payload ids. */
export const templatePayload = (tpl: TemplateRef, params: string[], buttons: OutboxButton[]) => {
  if (!tpl.whatsappTemplateName) throw new Error("No WhatsApp template name");
  if (params.length !== tpl.whatsappParams.length)
    throw new Error(`Template ${tpl.whatsappTemplateName} needs ${tpl.whatsappParams.length} parameters`);
  const components: Record<string, unknown>[] = [];
  if (params.length)
    components.push({ type: "body", parameters: params.map((text) => ({ type: "text", text: text.slice(0, 1024) })) });
  buttons.slice(0, 3).forEach((b, i) =>
    components.push({
      type: "button",
      sub_type: "quick_reply",
      index: String(i),
      parameters: [{ type: "payload", payload: b.id }],
    }),
  );
  return {
    type: "template",
    template: { name: tpl.whatsappTemplateName, language: { code: tpl.whatsappLanguage }, components },
  };
};

const sendWhatsApp = async (input: PatientSend, params: string[]) => {
  const conv = await conversationFor(input.phone);
  const inside = Boolean(conv.lastInboundAt && Date.now() - new Date(conv.lastInboundAt).getTime() < WINDOW_MS);

  let messageKind: "session" | "template";
  let bodies: Record<string, unknown>[];
  let numbered: { n: number; id: string; label: string }[] | null = null;
  let rich: OutboundMessage | null = null;
  if (inside) {
    messageKind = "session";
    rich = input.buttons.length
      ? { type: "quick_replies", text: input.text, options: input.buttons.map((b) => ({ id: b.id, label: b.label })) }
      : null;
    const rendered = renderForWhatsApp(rich ?? { type: "text", text: input.text });
    bodies = rendered.bodies;
    if (rendered.numberedOptions.length)
      numbered = rendered.numberedOptions.map((o, i) => ({ n: i + 1, id: o.id, label: o.label }));
  } else {
    if (!input.template?.whatsappTemplateName)
      return {
        ok: false as const,
        error: "Outside the 24-hour window and this message has no approved WhatsApp template",
      };
    messageKind = "template";
    bodies = [templatePayload(input.template, params, input.buttons)];
    rich = input.buttons.length
      ? { type: "quick_replies", text: input.text, options: input.buttons.map((b) => ({ id: b.id, label: b.label })) }
      : null;
  }
  const payloads = bodies.map((b) => toPayload(conv.channelUserId, b));

  const chat = await ChatMessageModel.create({
    conversation: conv._id,
    channel: "whatsapp",
    direction: "outbound",
    sender: "automation",
    text: input.text,
    rich,
    deliveryStatus: "pending",
    channelPayload: payloads,
  });
  const outbox = (await OutboxMessageModel.create({
    ...baseRow(input),
    channel: "whatsapp",
    messageKind,
    whatsappTemplateName: messageKind === "template" ? input.template?.whatsappTemplateName : null,
    status: "sending",
    conversation: conv._id,
    chatMessage: chat._id,
    replyWindowClosesAt: conv.lastInboundAt ? new Date(new Date(conv.lastInboundAt).getTime() + WINDOW_MS) : null,
    payload: payloads,
  })) as OutboxMessageDocument;

  const transport = transportFor();
  let firstId: string | null = null;
  let error: string | null = null;
  for (const p of payloads) {
    const r = await transport.send(p);
    if (r.ok) firstId ??= r.messageId;
    else error = r.error;
  }
  const status = error ? "failed" : "sent";
  await ChatMessageModel.updateOne(
    { _id: chat._id },
    { $set: { externalMessageId: firstId, deliveryStatus: status, deliveryError: error } },
  );
  outbox.status = status;
  outbox.providerMessageId = firstId;
  outbox.error = error;
  outbox.sentAt = error ? null : new Date();
  outbox.deliveryUpdates.push({ status, at: new Date(), error });
  await outbox.save();
  await ConversationModel.updateOne(
    { _id: conv._id },
    {
      $set: {
        lastMessageAt: new Date(),
        lastPreview: input.text.slice(0, 200),
        ...(numbered && { lastOptions: numbered }),
      },
      $inc: { "metrics.messageCount": 1 },
    },
  );
  return error ? { ok: false as const, error, outbox } : { ok: true as const, outbox };
};

// ------------------------------------------------------------------ public API

const baseRow = (input: PatientSend) => ({
  patient: input.patientId ? new Types.ObjectId(input.patientId) : null,
  toType: input.toType ?? "patient",
  toRef: input.phone,
  source: input.source,
  templateKey: input.template?.key ?? null,
  templateVersion: input.template?.version ?? null,
  variables: input.variables ?? {},
  renderedText: input.text,
  interactive: input.buttons.length ? { buttons: input.buttons } : null,
  language: input.language,
  scheduledFor: input.scheduledFor ?? null,
  relatedType: input.related?.type ?? null,
  relatedId: input.related?.id ?? null,
  ruleKey: input.ruleKey ?? null,
  job: input.jobId ?? null,
  createdBy: input.createdBy ? new Types.ObjectId(input.createdBy) : null,
  retryOf: input.retryOf ?? null,
});

/**
 * Send one message to a patient's phone, trying each channel in order. Every attempt is an Outbox row;
 * the returned row is the one that went out (or the last failure).
 */
export const sendToPatientPhone = async (input: PatientSend): Promise<SendOutcome> => {
  const settings = await getSettings();
  const attempts: SendOutcome["attempts"] = [];
  let last: OutboxMessageDocument | null = null;
  const params = input.params ?? input.template?.whatsappParams.map((p) => input.variables?.[p] || "-") ?? [];

  for (const channel of input.channels) {
    if (channel === "whatsapp") {
      if (!isWhatsAppConfigured()) {
        attempts.push({ channel, result: "failed", error: "WhatsApp is not configured" });
        continue;
      }
      const r = await sendWhatsApp(input, params);
      if (r.outbox) last = r.outbox;
      attempts.push({ channel, result: r.ok ? "sent" : "failed", error: r.ok ? null : r.error });
      if (r.ok) return { outbox: r.outbox, attempts };
    }
    if (channel === "sms") {
      if (!settings.smsFallbackEnabled) continue;
      const provider = smsProvider();
      const r = await provider.send(input.phone, input.text);
      const outbox = (await OutboxMessageModel.create({
        ...baseRow(input),
        interactive: null, // SMS has no buttons
        channel: "sms",
        messageKind: "sms",
        status: r.ok ? "sent" : "failed",
        providerMessageId: r.ok ? r.messageId : null,
        error: r.ok ? null : r.error,
        sentAt: r.ok ? new Date() : null,
        deliveryUpdates: [{ status: r.ok ? "sent" : "failed", at: new Date(), error: r.ok ? null : r.error }],
      })) as OutboxMessageDocument;
      last = outbox;
      attempts.push({ channel, result: r.ok ? "sent" : "failed", error: r.ok ? null : r.error });
      if (r.ok) return { outbox, attempts };
    }
  }

  // Nothing went out: keep a failed row so the Outbox shows what was attempted and why
  if (!last)
    last = (await OutboxMessageModel.create({
      ...baseRow(input),
      channel: input.channels[0] ?? "whatsapp",
      messageKind: "session",
      status: "failed",
      error:
        attempts
          .map((a) => `${a.channel}: ${a.error}`)
          .join("; ")
          .slice(0, 500) || "No channel available",
      deliveryUpdates: [{ status: "failed", at: new Date(), error: "No channel available" }],
    })) as OutboxMessageDocument;
  return { outbox: last, attempts };
};

export type StaffSend = {
  permission: Permission;
  text: string;
  language?: "bn" | "en";
  loud?: boolean;
  source?: OutboxSource;
  ruleKey?: string | null;
  jobId?: unknown;
  templateKey?: string | null;
  templateVersion?: number | null;
  variables?: Record<string, string>;
  related?: { type: string; id: string } | null;
};

/** In-app alert to every online staff member with a permission (header bell / toast) */
export const sendToStaff = async (input: StaffSend): Promise<OutboxMessageDocument> => {
  const outbox = (await OutboxMessageModel.create({
    toType: input.permission === "settings:manage" ? "admin" : "staff",
    toRef: `perm:${input.permission}`,
    channel: "inapp",
    source: input.source ?? "automation",
    messageKind: "inapp",
    templateKey: input.templateKey ?? null,
    templateVersion: input.templateVersion ?? null,
    variables: input.variables ?? {},
    renderedText: input.text,
    language: input.language ?? "en",
    status: "sent",
    sentAt: new Date(),
    deliveryUpdates: [{ status: "sent", at: new Date() }],
    relatedType: input.related?.type ?? null,
    relatedId: input.related?.id ?? null,
    ruleKey: input.ruleKey ?? null,
    job: input.jobId ?? null,
  })) as OutboxMessageDocument;
  emitToPermission(input.permission, "automation:alert", {
    id: String(outbox._id),
    text: input.text,
    loud: Boolean(input.loud),
    ruleKey: input.ruleKey ?? null,
    related: input.related ?? null,
    at: outbox.createdAt,
  });
  return outbox;
};

/**
 * Raw WhatsApp send for messages that are not templates or conversations (verification codes).
 * Still an Outbox row — but the text stored is MASKED (a code must never sit in the database).
 */
export const sendRawWhatsApp = async (input: {
  phone: string;
  body: Record<string, unknown>;
  maskedText: string;
  source: OutboxSource;
  createdBy?: string | null;
}) => {
  const to = input.phone.replace(/^\+/, "");
  const payload = toPayload(to, input.body);
  const r = await transportFor().send(payload);
  await OutboxMessageModel.create({
    toType: "patient",
    toRef: input.phone,
    channel: "whatsapp",
    source: input.source,
    messageKind: "session",
    renderedText: input.maskedText,
    language: "bn",
    status: r.ok ? "sent" : "failed",
    providerMessageId: r.ok ? r.messageId : null,
    error: r.ok ? null : r.error,
    sentAt: r.ok ? new Date() : null,
    deliveryUpdates: [{ status: r.ok ? "sent" : "failed", at: new Date(), error: r.ok ? null : r.error }],
    createdBy: input.createdBy ? new Types.ObjectId(input.createdBy) : null,
  });
  return r;
};
