import express, { Request, Response } from "express";
import { z } from "zod";
import { authenticate } from "../../middlewares/authenticate";
import { requirePermission } from "../../middlewares/authorize";
import validateRequest, { objectIdSchema } from "../../middlewares/validateRequest";
import catchAsync from "../../utils/catchAsync";
import sendResponse from "../../utils/sendResponse";
import { previewAnswer } from "../assistant/engine";
import { KNOWLEDGE_CATEGORIES } from "./knowledge.model";
import * as service from "./knowledge.service";

const articleBody = z
  .object({
    titleEn: z.string().trim().max(200).optional(),
    titleBn: z.string().trim().max(200).optional(),
    category: z.enum(KNOWLEDGE_CATEGORIES),
    contentEn: z.string().max(20000).optional(),
    contentBn: z.string().max(20000).optional(),
  })
  .strict();
const idParams = z.object({ id: objectIdSchema });

const ok = (res: Response, message: string, data: unknown, statusCode = 200) =>
  sendResponse(res, { statusCode, success: true, message, data });

/** Mounted at /knowledge — Knowledge Base admin (knowledge:manage) */
const router = express.Router();
router.use(authenticate(), requirePermission("knowledge:manage"));

router.get(
  "/articles",
  validateRequest(
    z.object({
      query: z.object({
        q: z.string().trim().max(100).optional(),
        status: z.enum(["draft", "published"]).optional(),
        category: z.enum(KNOWLEDGE_CATEGORIES).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(25),
      }),
    }),
  ),
  catchAsync(async (req: Request, res: Response) => {
    const { items, pagination } = await service.listArticles(req.query as never);
    sendResponse(res, { statusCode: 200, success: true, message: "Articles", data: items, pagination });
  }),
);
router.post(
  "/articles",
  validateRequest(z.object({ body: articleBody })),
  catchAsync(async (req, res) => ok(res, "Article created", await service.createArticle(req, req.body), 201)),
);
router.get(
  "/articles/:id",
  validateRequest(z.object({ params: idParams })),
  catchAsync(async (req, res) => ok(res, "Article", await service.getArticle(req.params.id))),
);
router.patch(
  "/articles/:id",
  validateRequest(z.object({ params: idParams, body: articleBody.partial().strict() })),
  catchAsync(async (req, res) => ok(res, "Article saved", await service.updateArticle(req, req.params.id, req.body))),
);
router.post(
  "/articles/:id/publish",
  validateRequest(z.object({ params: idParams })),
  catchAsync(async (req, res) => ok(res, "Published", await service.setPublished(req, req.params.id, true))),
);
router.post(
  "/articles/:id/unpublish",
  validateRequest(z.object({ params: idParams })),
  catchAsync(async (req, res) => ok(res, "Unpublished", await service.setPublished(req, req.params.id, false))),
);
router.delete(
  "/articles/:id",
  validateRequest(z.object({ params: idParams })),
  catchAsync(async (req, res) => {
    await service.deleteArticle(req, req.params.id);
    ok(res, "Article deleted", null);
  }),
);
router.post(
  "/reindex",
  catchAsync(async (req, res) => ok(res, "Knowledge base re-indexed", await service.reindexAll(req))),
);

/** "Test the assistant": retrieved passages with scores + the assistant's answer (nothing stored) */
router.post(
  "/test",
  validateRequest(z.object({ body: z.object({ question: z.string().trim().min(2).max(500) }).strict() })),
  catchAsync(async (req, res) => {
    const passages = await service.retrievePassages(req.body.question);
    let answer: Awaited<ReturnType<typeof previewAnswer>> | { error: string };
    try {
      answer = await previewAnswer(req.body.question);
    } catch (err) {
      answer = { error: (err as Error).message };
    }
    ok(res, "Test result", { passages, answer });
  }),
);

export const KnowledgeRoutes = router;
