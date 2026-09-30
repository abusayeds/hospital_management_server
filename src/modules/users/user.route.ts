import express from "express";
import { authenticate } from "../../middlewares/authenticate";
import { requirePermission } from "../../middlewares/authorize";
import validateRequest from "../../middlewares/validateRequest";
import { userController } from "./user.controller";
import { createUserSchema, listUsersSchema, updateUserSchema, userIdSchema } from "./user.validation";

const router = express.Router();

// Every route below: signed in AND allowed to manage users
router.use(authenticate(), requirePermission("user:manage"));

router.get("/", validateRequest(listUsersSchema), userController.list);
router.get("/summary", userController.summary);
router.post("/", validateRequest(createUserSchema), userController.create);
router.get("/:id", validateRequest(userIdSchema), userController.get);
router.patch("/:id", validateRequest(updateUserSchema), userController.update);
router.patch("/:id/deactivate", validateRequest(userIdSchema), userController.deactivate);
router.patch("/:id/activate", validateRequest(userIdSchema), userController.activate);
router.post("/:id/reset-password", validateRequest(userIdSchema), userController.resetPassword);

export const UserRoutes = router;
