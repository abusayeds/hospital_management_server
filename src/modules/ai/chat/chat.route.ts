import express, { Request, Response } from "express";
import httpStatus from "http-status";
import { z } from "zod";
import { authenticate } from "../../../middlewares/authenticate";
import { requirePermission } from "../../../middlewares/authorize";
import { chatLimiter } from "../../../middlewares/rateLimiter";
import validateRequest from "../../../middlewares/validateRequest";
import catchAsync from "../../../utils/catchAsync";
import sendResponse from "../../../utils/sendResponse";
import { chatService } from "./chat.service";

const sendMessageValidation = z.object({
  body: z.object({
    sessionId: z.string().uuid().optional(),
    message: z.string().trim().min(1, "message is required").max(1000, "message is too long"),
  }),
});

const sendMessage = catchAsync(async (req: Request, res: Response) => {
  const result = await chatService.handleChatMessage(req.body);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Reply", data: result });
});

// Lets the patient's browser restore its own conversation (sessionId is a random UUID)
const getSession = catchAsync(async (req: Request, res: Response) => {
  const session = await chatService.getChatSession(req.params.sessionId);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Chat session",
    data: { sessionId: session.sessionId, messages: session.messages },
  });
});

const listSessions = catchAsync(async (req: Request, res: Response) => {
  const sessions = await chatService.listChatSessions({ flagged: req.query.flagged === "true" });
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Chat sessions", data: sessions });
});

const getSessionForStaff = catchAsync(async (req: Request, res: Response) => {
  const session = await chatService.getChatSession(req.params.sessionId);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Chat session", data: session });
});

const resolveSession = catchAsync(async (req: Request, res: Response) => {
  const session = await chatService.resolveChatSession(req.params.sessionId);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Marked as resolved", data: session });
});

const router = express.Router();
router.post("/message", chatLimiter, validateRequest(sendMessageValidation), sendMessage);
router.get("/sessions", authenticate(), requirePermission("assistant_chat:manage"), listSessions);
router.get("/sessions/:sessionId", authenticate(), requirePermission("assistant_chat:manage"), getSessionForStaff);
router.patch(
  "/sessions/:sessionId/resolve",
  authenticate(),
  requirePermission("assistant_chat:manage"),
  resolveSession,
);
router.get("/:sessionId", getSession);

export const ChatRoutes = router;
