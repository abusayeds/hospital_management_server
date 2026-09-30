import express, { Request, Response } from "express";
import { z } from "zod";
import { authenticate } from "../../../middlewares/authenticate";
import { requireAnyPermission, requirePermission } from "../../../middlewares/authorize";
import validateRequest, { objectIdSchema } from "../../../middlewares/validateRequest";
import catchAsync from "../../../utils/catchAsync";
import sendResponse from "../../../utils/sendResponse";
import { departmentService } from "./department.service";

// ---- validation
const body = z.object({
  name: z.string().trim().min(2).max(80),
  nameBn: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).optional(),
  icon: z.string().trim().regex(/^[a-z0-9-]{2,40}$/, "use a lucide icon key such as heart-pulse").optional(),
  displayOrder: z.number().int().min(0).max(1000).optional(),
});
const idParams = z.object({ id: objectIdSchema });
const listSchema = z.object({ query: z.object({ status: z.enum(["active", "inactive"]).optional() }) });
const createSchema = z.object({ body });
const updateSchema = z.object({ params: idParams, body: body.partial() });
const idSchema = z.object({ params: idParams });

// ---- controller
const list = catchAsync(async (req: Request, res: Response) => {
  const data = await departmentService.listDepartments(req.query as { status?: "active" | "inactive" });
  sendResponse(res, { statusCode: 200, success: true, message: "Departments", data });
});
const create = catchAsync(async (req: Request, res: Response) => {
  sendResponse(res, { statusCode: 201, success: true, message: "Department created", data: await departmentService.createDepartment(req, req.body) });
});
const update = catchAsync(async (req: Request, res: Response) => {
  sendResponse(res, { statusCode: 200, success: true, message: "Department updated", data: await departmentService.updateDepartment(req, req.params.id, req.body) });
});
const setActive = (active: boolean) =>
  catchAsync(async (req: Request, res: Response) => {
    const data = await departmentService.setDepartmentActive(req, req.params.id, active);
    sendResponse(res, { statusCode: 200, success: true, message: active ? "Department activated" : "Department deactivated", data });
  });

// ---- routes
const router = express.Router();
router.use(authenticate());
router.get("/", requireAnyPermission(["doctor:read", "master_data:manage"]), validateRequest(listSchema), list);
router.post("/", requirePermission("master_data:manage"), validateRequest(createSchema), create);
router.patch("/:id", requirePermission("master_data:manage"), validateRequest(updateSchema), update);
router.patch("/:id/activate", requirePermission("master_data:manage"), validateRequest(idSchema), setActive(true));
router.patch("/:id/deactivate", requirePermission("master_data:manage"), validateRequest(idSchema), setActive(false));

export const DepartmentRoutes = router;
