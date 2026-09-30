import express, { Request, Response } from "express";
import { z } from "zod";
import { authenticate } from "../middlewares/authenticate";
import { requirePermission } from "../middlewares/authorize";
import validateRequest from "../middlewares/validateRequest";
import { buildPagination } from "../interface/global.interface";
import catchAsync from "../utils/catchAsync";
import sendResponse from "../utils/sendResponse";
import { paginationQuery } from "../validators/common";
import { DOMAIN_EVENT_NAMES } from "./catalog";
import { DomainEventModel } from "./domainEvent.model";

// Read-only event log for administrators (payloads contain ids only).

const listSchema = z.object({
  query: z.object({
    name: z.enum(DOMAIN_EVENT_NAMES).optional(),
    status: z.enum(["pending", "done", "failed"]).optional(),
    ...paginationQuery,
  }),
});

const list = catchAsync(async (req: Request, res: Response) => {
  const { name, status, page, limit } = req.query as unknown as {
    name?: string;
    status?: string;
    page: number;
    limit: number;
  };
  const filter: Record<string, unknown> = {};
  if (name) filter.name = name;
  if (status) filter["consumers.status"] = status;
  const [items, total] = await Promise.all([
    DomainEventModel.find(filter)
      .sort({ occurredAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    DomainEventModel.countDocuments(filter),
  ]);
  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Domain events",
    data: items.map(({ _id, ...rest }) => ({ id: String(_id), ...rest })),
    pagination: buildPagination(page, limit, total),
  });
});

const router = express.Router();
router.get("/", authenticate(), requirePermission("audit:read"), validateRequest(listSchema), list);

export const EventRoutes = router;
