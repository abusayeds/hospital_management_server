/* eslint-disable @typescript-eslint/no-explicit-any */
import express, { Request, Response } from "express";
import { AnyZodObject, z } from "zod";
import type { Permission } from "../../../config/permissions";
import AppError from "../../../errors/AppError";
import { buildPagination } from "../../../interface/global.interface";
import { authenticate } from "../../../middlewares/authenticate";
import { requireAnyPermission, requirePermission } from "../../../middlewares/authorize";
import validateRequest, { objectIdSchema } from "../../../middlewares/validateRequest";
import { paginationQuery } from "../../../validators/common";
import catchAsync from "../../../utils/catchAsync";
import { escapeRegex } from "../../../utils/escapeRegex";
import sendResponse from "../../../utils/sendResponse";
import { serialize } from "../../../utils/serialize";
import { recordAudit } from "../../audit/audit.service";

/**
 * Services, lab tests and medicines are "simple catalogs": the same list / create /
 * update / activate / deactivate behaviour, the same audit trail, the same permissions.
 * One implementation serves all three, so a fix or rule applies everywhere at once.
 * (Departments and doctors have extra rules and their own modules.)
 */
type CatalogOptions = {
  model: any;
  entityType: string; // audit log label, e.g. "LabTest"
  searchFields: string[]; // matched case-insensitively by ?q=
  sort: Record<string, 1 | -1>;
  createBody: AnyZodObject;
  extraListQuery?: Record<string, z.ZodTypeAny>; // e.g. { category: z.string().optional() }
  readPermissions: Permission[];
  managePermission: Permission;
};

export const makeCatalog = (opts: CatalogOptions) => {
  // ---------------------------------------------------------------- service
  const findOrThrow = async (id: string) => {
    const doc = await opts.model.findById(id);
    if (!doc) throw new AppError(404, `${opts.entityType} not found.`);
    return doc;
  };

  const list = async (query: Record<string, any>) => {
    const { q, status, page, limit, ...extra } = query;
    const filter: Record<string, unknown> = {};
    if (status) filter.isActive = status === "active";
    for (const [key, value] of Object.entries(extra)) if (value !== undefined && value !== "") filter[key] = value;
    if (q) {
      const rx = new RegExp(escapeRegex(q), "i");
      filter.$or = opts.searchFields.map((f) => ({ [f]: rx }));
    }
    const [items, total] = await Promise.all([
      opts.model
        .find(filter)
        .sort(opts.sort)
        .skip((page - 1) * limit)
        .limit(limit),
      opts.model.countDocuments(filter),
    ]);
    return { items: items.map(serialize), pagination: buildPagination(page, limit, total) };
  };

  const create = async (req: Request, input: Record<string, unknown>) => {
    const doc = await opts.model.create({ ...input, createdBy: req.user!.id });
    await recordAudit({ req, action: "CREATE", entityType: opts.entityType, entityId: doc._id, after: serialize(doc) });
    return serialize(doc);
  };

  const update = async (req: Request, id: string, input: Record<string, unknown>) => {
    const doc = await findOrThrow(id);
    const before = serialize(doc);
    doc.set({ ...input, updatedBy: req.user!.id });
    await doc.save();
    await recordAudit({
      req,
      action: "UPDATE",
      entityType: opts.entityType,
      entityId: doc._id,
      before,
      after: serialize(doc),
    });
    return serialize(doc);
  };

  // Catalog rows are referenced by old bills and prescriptions, so they are never
  // deleted — only deactivated (hidden from pickers, kept for history).
  const setActive = async (req: Request, id: string, active: boolean) => {
    const doc = await findOrThrow(id);
    if (doc.isActive === active) return serialize(doc);
    doc.isActive = active;
    doc.updatedBy = req.user!.id;
    await doc.save();
    await recordAudit({
      req,
      action: active ? "ACTIVATE" : "DEACTIVATE",
      entityType: opts.entityType,
      entityId: doc._id,
      after: { isActive: active },
    });
    return serialize(doc);
  };

  // ---------------------------------------------------------------- validation
  const idParams = z.object({ params: z.object({ id: objectIdSchema }) });
  const listSchema = z.object({
    query: z.object({
      q: z.string().trim().max(100).optional(),
      status: z.enum(["active", "inactive"]).optional(),
      ...paginationQuery,
      ...(opts.extraListQuery ?? {}),
    }),
  });
  const createSchema = z.object({ body: opts.createBody });
  const updateSchema = z.object({ params: z.object({ id: objectIdSchema }), body: opts.createBody.partial() });

  // ---------------------------------------------------------------- controller + routes
  const router = express.Router();
  router.use(authenticate());
  const canRead = requireAnyPermission([...opts.readPermissions, opts.managePermission]);
  const canManage = requirePermission(opts.managePermission);

  router.get(
    "/",
    canRead,
    validateRequest(listSchema),
    catchAsync(async (req: Request, res: Response) => {
      const { items, pagination } = await list(req.query);
      sendResponse(res, {
        statusCode: 200,
        success: true,
        message: `${opts.entityType} list`,
        data: items,
        pagination,
      });
    }),
  );
  router.get(
    "/:id",
    canRead,
    validateRequest(idParams),
    catchAsync(async (req: Request, res: Response) => {
      sendResponse(res, {
        statusCode: 200,
        success: true,
        message: opts.entityType,
        data: serialize(await findOrThrow(req.params.id)),
      });
    }),
  );
  router.post(
    "/",
    canManage,
    validateRequest(createSchema),
    catchAsync(async (req: Request, res: Response) => {
      sendResponse(res, {
        statusCode: 201,
        success: true,
        message: `${opts.entityType} created`,
        data: await create(req, req.body),
      });
    }),
  );
  router.patch(
    "/:id",
    canManage,
    validateRequest(updateSchema),
    catchAsync(async (req: Request, res: Response) => {
      sendResponse(res, {
        statusCode: 200,
        success: true,
        message: `${opts.entityType} updated`,
        data: await update(req, req.params.id, req.body),
      });
    }),
  );
  for (const [path, active] of [
    ["activate", true],
    ["deactivate", false],
  ] as const) {
    router.patch(
      `/:id/${path}`,
      canManage,
      validateRequest(idParams),
      catchAsync(async (req: Request, res: Response) => {
        sendResponse(res, {
          statusCode: 200,
          success: true,
          message: `${opts.entityType} ${path}d`,
          data: await setActive(req, req.params.id, active),
        });
      }),
    );
  }

  return { router, service: { list, create, update, setActive, findOrThrow } };
};
