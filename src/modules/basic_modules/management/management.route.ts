import express from "express";

import { authenticate } from "../../../middlewares/authenticate";
import { requirePermission } from "../../../middlewares/authorize";
import { managementController } from "./management.controller";

const router = express.Router();
// Public pages (terms/about/privacy) are readable by anyone but editable only by admins
router.post("/create", authenticate(), requirePermission("settings:manage"), managementController.createManagement);
router.get("/:type", managementController.getManagement);
export const managementRoutes = router;
