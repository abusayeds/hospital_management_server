import express, { Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { authenticate } from "../../../middlewares/authenticate";
import { requirePermission } from "../../../middlewares/authorize";
import validateRequest, { objectIdSchema } from "../../../middlewares/validateRequest";
import catchAsync from "../../../utils/catchAsync";
import sendResponse from "../../../utils/sendResponse";
import { aiSummaryService } from "./aiSummary.service";

const idParams = z.object({ id: objectIdSchema });

// AI calls cost money: repeated "Regenerate" clicks by one user are slowed down
const generateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? "anonymous",
});

const ok = (res: Response, message: string, data: unknown) =>
  sendResponse(res, { statusCode: 200, success: true, message, data });

/** Mounted at /patients */
const router = express.Router();
router.use("/:id/ai-summary", authenticate(), requirePermission("ai_summary:use"));
router.get(
  "/:id/ai-summary",
  validateRequest(z.object({ params: idParams })),
  catchAsync(async (req: Request, res: Response) =>
    ok(res, "Visit summary", await aiSummaryService.getSummary(req, req.params.id)),
  ),
);
router.post(
  "/:id/ai-summary",
  generateLimiter,
  validateRequest(z.object({ params: idParams, body: z.object({ force: z.boolean().optional() }).strict() })),
  catchAsync(async (req: Request, res: Response) =>
    ok(
      res,
      "Visit summary generated",
      await aiSummaryService.generateSummary(req, req.params.id, Boolean(req.body.force)),
    ),
  ),
);
router.post(
  "/:id/ai-summary/feedback",
  validateRequest(
    z.object({
      params: idParams,
      body: z.object({ rating: z.enum(["up", "down"]), comment: z.string().trim().max(500).optional() }).strict(),
    }),
  ),
  catchAsync(async (req: Request, res: Response) =>
    ok(res, "Thanks for the feedback", await aiSummaryService.giveFeedback(req, req.params.id, req.body)),
  ),
);

export const AiSummaryRoutes = router;
