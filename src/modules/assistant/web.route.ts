import { randomBytes } from "crypto";
import express, { Request, Response } from "express";
import { z } from "zod";
import { env } from "../../config/env";
import { chatLimiter } from "../../middlewares/rateLimiter";
import validateRequest from "../../middlewares/validateRequest";
import catchAsync from "../../utils/catchAsync";
import sendResponse from "../../utils/sendResponse";
import { WEB_CHAT_COOKIE, toWebMessage } from "./channels/web.channel";
import { ChatMessageModel } from "./chatMessage.model";
import { ConversationModel } from "./conversation.model";
import { handleInbound } from "./engine";
import { recordChatSend } from "../automation/outbox/record";
import { MENU_OPTIONS } from "./interactions";

/**
 * PUBLIC WEB CHAT (no login). The visitor is identified by an anonymous random id in an httpOnly
 * cookie. To book they give a mobile number (no code); the chat then sees only what it added itself.
 * Production uses SameSite=None + Secure so the embeddable widget (an iframe on the hospital's
 * website) keeps its session.
 */

const isProduction = env.NODE_ENV === "production";
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

const sessionIdOf = (req: Request, res: Response) => {
  const existing = req.cookies?.[WEB_CHAT_COOKIE];
  if (typeof existing === "string" && /^[a-f0-9]{32}$/.test(existing)) return existing;
  const id = randomBytes(16).toString("hex");
  res.cookie(WEB_CHAT_COOKIE, id, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    maxAge: COOKIE_MAX_AGE,
    path: "/",
  });
  return id;
};

const conversationView = (
  c: { status: string; verifiedPhone?: string | null; phone?: string | null; language?: string } | null,
) => ({
  status: c?.status ?? "bot_active",
  verified: Boolean(c?.verifiedPhone),
  phoneMasked: c?.verifiedPhone || c?.phone ? `•••••${String(c.verifiedPhone ?? c.phone).slice(-3)}` : null,
  language: c?.language ?? "bn",
});

const WELCOME = {
  id: "welcome",
  sender: "bot",
  text:
    "আসসালামু আলাইকুম! আমি Testo Life Assistant। ডাক্তার খোঁজা, সিরিয়াল নেওয়া বা হাসপাতালের তথ্য — কীভাবে সাহায্য করতে পারি?\n" +
    "Hello! I'm the Testo Life Assistant. How can I help you today?",
  rich: { type: "quick_replies", text: "", options: MENU_OPTIONS },
  createdAt: null,
};

const sendSchema = z.object({
  body: z
    .object({
      text: z.string().trim().max(1000, "Message is too long (max 1000 characters)").optional(),
      replyId: z.string().trim().max(200).optional(),
      label: z.string().trim().max(200).optional(), // what the tapped button said (shown in the transcript)
    })
    .strict()
    .refine((b) => Boolean(b.text || b.replyId), { message: "Type a message", path: ["text"] }),
});

const send = catchAsync(async (req: Request, res: Response) => {
  const sessionId = sessionIdOf(req, res);
  const result = await handleInbound({
    channel: "web",
    channelUserId: sessionId,
    text: req.body.text || req.body.label,
    replyId: req.body.replyId,
    timestamp: new Date(),
  });
  // Bot replies travel in this HTTP response — and are recorded in the Outbox like every other send
  if (!result.duplicate) await recordChatSend(result.conversation, result.stored);
  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Reply",
    data: { conversation: conversationView(result.conversation), messages: result.stored.map(toWebMessage) },
  });
});

/** Restore the visitor's own conversation (their cookie only) */
const history = catchAsync(async (req: Request, res: Response) => {
  const sessionId = sessionIdOf(req, res);
  const conv = await ConversationModel.findOne({ channel: "web", channelUserId: sessionId });
  const messages = conv
    ? await ChatMessageModel.find({ conversation: conv._id }).sort({ createdAt: -1 }).limit(60).lean()
    : [];
  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Conversation",
    data: {
      conversation: conversationView(conv),
      messages: [WELCOME, ...messages.reverse().map(toWebMessage)],
    },
  });
});

const router = express.Router();
router.get("/conversation", history);
router.post("/messages", chatLimiter, validateRequest(sendSchema), send);

export const WebChatRoutes = router;
