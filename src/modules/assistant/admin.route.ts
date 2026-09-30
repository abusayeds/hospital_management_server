/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomBytes } from "crypto";
import express, { Request, Response } from "express";
import { z } from "zod";
import { env } from "../../config/env";
import AppError from "../../errors/AppError";
import { authenticate } from "../../middlewares/authenticate";
import { requireAnyPermission, requirePermission } from "../../middlewares/authorize";
import validateRequest from "../../middlewares/validateRequest";
import catchAsync from "../../utils/catchAsync";
import sendResponse from "../../utils/sendResponse";
import { toE164Bd } from "../../utils/phone";
import { recordAudit } from "../audit/audit.service";
import { drainWhatsApp, processWebhook, whatsappInfo } from "./channels/whatsapp/adapter";
import { isWhatsAppConfigured, toPayload, transportFor } from "./channels/whatsapp/client";
import { ChatMessageModel } from "./chatMessage.model";
import { ConversationModel } from "./conversation.model";
import { maskPhone } from "./otp.service";
import { VerificationModel } from "./verification.model";

const ok = (res: Response, message: string, data: unknown) =>
  sendResponse(res, { statusCode: 200, success: true, message, data });

const router = express.Router();
router.use(authenticate());

/** Admin → Channels: which channels work, the webhook URL to paste into Meta, last activity */
router.get(
  "/channels",
  requireAnyPermission(["settings:manage", "inbox:manage"]),
  catchAsync(async (req: Request, res: Response) => {
    const [web, wa] = await Promise.all(
      (["web", "whatsapp"] as const).map((channel) =>
        ConversationModel.findOne({ channel, simulated: { $ne: true } })
          .sort({ lastInboundAt: -1 })
          .select("lastInboundAt")
          .lean<any>(),
      ),
    );
    const base = `${req.protocol}://${req.get("host")}`;
    ok(res, "Channels", {
      web: {
        enabled: true,
        lastMessageAt: web?.lastInboundAt ?? null,
        widgetScript: `${env.PUBLIC_APP_URL ?? env.CLIENT_URL[0]}/widget.js`,
      },
      whatsapp: {
        ...whatsappInfo(),
        webhookUrl: `${base}/api/v1/webhooks/whatsapp`,
        lastMessageAt: wa?.lastInboundAt ?? null,
      },
    });
  }),
);

/** Send a plain test message to a number (only works inside the 24-hour window or to a test recipient) */
router.post(
  "/channels/whatsapp/test",
  requirePermission("settings:manage"),
  validateRequest(z.object({ body: z.object({ to: z.string().trim().min(8).max(20) }).strict() })),
  catchAsync(async (req: Request, res: Response) => {
    if (!isWhatsAppConfigured()) throw new AppError(409, "WhatsApp is not configured on this server.", "CONFLICT");
    const phone = toE164Bd(req.body.to);
    if (!phone) throw new AppError(400, "Enter a Bangladeshi mobile number.", "VALIDATION_ERROR");
    const r = await transportFor(false).send(
      toPayload(phone.replace("+", ""), {
        type: "text",
        text: { body: "Testolife: test message from the admin panel ✅" },
      }),
    );
    await recordAudit({ req, action: "UPDATE", entityType: "Channel", meta: { test: "whatsapp", ok: r.ok } });
    if (!r.ok) throw new AppError(502, `WhatsApp refused the message: ${r.error}`, "BAD_REQUEST");
    ok(res, "Test message sent", r);
  }),
);

/** Development only: the codes the log "sent" (SMS is not built yet) */
router.get(
  "/dev-otps",
  requireAnyPermission(["settings:manage", "inbox:manage"]),
  catchAsync(async (_req: Request, res: Response) => {
    if (env.NODE_ENV === "production") throw new AppError(404, "Not available in production.");
    const rows = await VerificationModel.find({ usedAt: null, expiresAt: { $gt: new Date() } })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean<any[]>();
    ok(
      res,
      "Development codes",
      rows.map((r) => ({ phone: maskPhone(r.phone), code: r.devCode, expiresAt: r.expiresAt, attempts: r.attempts })),
    );
  }),
);

// ------------------------------------------------------------------ WhatsApp simulator (admin)

const simBody = z.object({
  body: z
    .object({
      from: z.string().trim().min(8).max(20),
      name: z.string().trim().max(60).optional(),
      text: z.string().trim().max(1000).optional(),
      replyId: z.string().trim().max(200).optional(),
      title: z.string().trim().max(100).optional(),
      kind: z.enum(["text", "button", "list", "image"]).default("text"),
    })
    .strict(),
});

/** The same JSON Meta would POST to our webhook */
const buildWebhook = (b: z.infer<typeof simBody>["body"], waId: string) => {
  const id = `wamid.SIM.${randomBytes(8).toString("hex")}`;
  const message: Record<string, unknown> = { from: waId, id, timestamp: String(Math.floor(Date.now() / 1000)) };
  if (b.kind === "image")
    Object.assign(message, { type: "image", image: { id: "sim-media", mime_type: "image/jpeg" } });
  else if (b.replyId)
    Object.assign(message, {
      type: "interactive",
      interactive:
        b.kind === "list"
          ? { type: "list_reply", list_reply: { id: b.replyId, title: b.title ?? "" } }
          : { type: "button_reply", button_reply: { id: b.replyId, title: b.title ?? "" } },
    });
  else Object.assign(message, { type: "text", text: { body: b.text ?? "" } });
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "SIMULATOR",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: "SIMULATOR" },
              contacts: [{ wa_id: waId, profile: { name: b.name ?? "Simulator" } }],
              messages: [message],
            },
          },
        ],
      },
    ],
  };
};

const simulatorView = async (waId: string) => {
  const conv = await ConversationModel.findOne({
    channel: "whatsapp",
    channelUserId: waId,
    simulated: true,
  }).lean<any>();
  if (!conv) return { conversation: null, messages: [] };
  const messages = await ChatMessageModel.find({ conversation: conv._id })
    .sort({ createdAt: 1 })
    .limit(200)
    .lean<any[]>();
  return {
    conversation: { id: String(conv._id), status: conv.status, verified: Boolean(conv.verifiedPhone) },
    messages: messages.map((m) => ({
      id: String(m._id),
      direction: m.direction,
      sender: m.sender,
      text: m.text,
      replyId: m.replyId,
      payloads: m.channelPayload ?? [],
      deliveryStatus: m.deliveryStatus,
      deliveryError: m.deliveryError,
      createdAt: m.createdAt,
    })),
  };
};

const waIdOf = (phone: string) => {
  const e164 = toE164Bd(phone);
  if (!e164) throw new AppError(400, "Use a Bangladeshi number, e.g. 01711223344.", "VALIDATION_ERROR");
  return e164.replace("+", "");
};

router.post(
  "/simulator/whatsapp",
  requirePermission("settings:manage"),
  validateRequest(simBody),
  catchAsync(async (req: Request, res: Response) => {
    const waId = waIdOf(req.body.from);
    // Same path as a real webhook, minus the HTTP signature: adapter → engine → adapter (simulator transport)
    await processWebhook(buildWebhook(req.body, waId) as never, { simulated: true });
    await drainWhatsApp();
    ok(res, "Simulated", await simulatorView(waId));
  }),
);

router.get(
  "/simulator/whatsapp",
  requirePermission("settings:manage"),
  validateRequest(z.object({ query: z.object({ from: z.string().trim().min(8).max(20) }) })),
  catchAsync(async (req: Request, res: Response) =>
    ok(res, "Simulator", await simulatorView(waIdOf(String(req.query.from)))),
  ),
);

router.delete(
  "/simulator/whatsapp",
  requirePermission("settings:manage"),
  validateRequest(z.object({ query: z.object({ from: z.string().trim().min(8).max(20) }) })),
  catchAsync(async (req: Request, res: Response) => {
    const conv = await ConversationModel.findOne({
      channel: "whatsapp",
      channelUserId: waIdOf(String(req.query.from)),
      simulated: true,
    });
    if (conv) {
      await ChatMessageModel.deleteMany({ conversation: conv._id });
      await ConversationModel.deleteOne({ _id: conv._id });
    }
    ok(res, "Simulator conversation cleared", null);
  }),
);

export const AssistantAdminRoutes = router;
