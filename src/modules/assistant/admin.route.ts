/* eslint-disable @typescript-eslint/no-explicit-any */
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
import { whatsappInfo } from "./channels/whatsapp/adapter";
import { isWhatsAppConfigured } from "./channels/whatsapp/client";
import { sendRawWhatsApp } from "../automation/outbox/outbox.service";
import { ConversationModel } from "./conversation.model";

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
        ConversationModel.findOne({ channel }).sort({ lastInboundAt: -1 }).select("lastInboundAt").lean<any>(),
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
    const r = await sendRawWhatsApp({
      phone,
      body: { type: "text", text: { body: "Testolife: test message from the admin panel ✅" } },
      maskedText: "Testolife: test message from the admin panel ✅",
      source: "test",
      createdBy: req.user!.id,
    });
    await recordAudit({ req, action: "UPDATE", entityType: "Channel", meta: { test: "whatsapp", ok: r.ok } });
    if (!r.ok) throw new AppError(502, `WhatsApp refused the message: ${r.error}`, "BAD_REQUEST");
    ok(res, "Test message sent", r);
  }),
);

export const AssistantAdminRoutes = router;
