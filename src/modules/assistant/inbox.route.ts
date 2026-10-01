import express, { Request, Response } from "express";
import { z } from "zod";
import { authenticate } from "../../middlewares/authenticate";
import { requirePermission } from "../../middlewares/authorize";
import validateRequest, { objectIdSchema } from "../../middlewares/validateRequest";
import catchAsync from "../../utils/catchAsync";
import sendResponse from "../../utils/sendResponse";
import * as inbox from "./inbox.service";

const idParams = z.object({ id: objectIdSchema });
const idSchema = z.object({ params: idParams });

const ok = (res: Response, message: string, data: unknown) =>
  sendResponse(res, { statusCode: 200, success: true, message, data });

/** Mounted at /assistant/inbox — staff inbox (inbox:manage) */
const router = express.Router();
router.use(authenticate(), requirePermission("inbox:manage"));

router.get(
  "/conversations",
  validateRequest(
    z.object({
      query: z.object({
        filter: z.enum(inbox.INBOX_FILTERS).default("open"),
        channel: z.enum(["web", "whatsapp"]).optional(),
        q: z.string().trim().max(100).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      }),
    }),
  ),
  catchAsync(async (req: Request, res: Response) => {
    const { items, pagination } = await inbox.listConversations(req.query as never);
    sendResponse(res, { statusCode: 200, success: true, message: "Conversations", data: items, pagination });
  }),
);
router.get(
  "/summary",
  catchAsync(async (_req, res) => ok(res, "Inbox summary", await inbox.inboxSummary())),
);
router.get("/canned", (_req, res) => ok(res, "Quick replies", inbox.CANNED_REPLIES));
router.get(
  "/conversations/:id",
  validateRequest(idSchema),
  catchAsync(async (req, res) => ok(res, "Conversation", await inbox.getConversation(req, req.params.id))),
);
router.post(
  "/conversations/:id/takeover",
  validateRequest(idSchema),
  catchAsync(async (req, res) => ok(res, "You are now handling this chat", await inbox.takeOver(req, req.params.id))),
);
router.post(
  "/conversations/:id/reply",
  validateRequest(
    z.object({ params: idParams, body: z.object({ text: z.string().trim().min(1).max(2000) }).strict() }),
  ),
  catchAsync(async (req, res) => ok(res, "Sent", await inbox.staffReply(req, req.params.id, req.body.text))),
);
router.post(
  "/conversations/:id/handback",
  validateRequest(idSchema),
  catchAsync(async (req, res) => ok(res, "Handed back to the assistant", await inbox.handBack(req, req.params.id))),
);
router.post(
  "/conversations/:id/resolve",
  validateRequest(idSchema),
  catchAsync(async (req, res) => ok(res, "Resolved", await inbox.resolve(req, req.params.id))),
);
router.put(
  "/conversations/:id/tags",
  validateRequest(
    z.object({ params: idParams, body: z.object({ tags: z.array(z.string().trim().max(30)).max(12) }).strict() }),
  ),
  catchAsync(async (req, res) => ok(res, "Tags saved", await inbox.setTags(req, req.params.id, req.body.tags))),
);
router.post(
  "/conversations/:id/notes",
  validateRequest(
    z.object({ params: idParams, body: z.object({ text: z.string().trim().min(1).max(1000) }).strict() }),
  ),
  catchAsync(async (req, res) => ok(res, "Note added", await inbox.addNote(req, req.params.id, req.body.text))),
);

export const InboxRoutes = router;
