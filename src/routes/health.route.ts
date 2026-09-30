import express from "express";
import { healthController } from "../controllers/health.controller";

const router = express.Router();
router.get("/", healthController.getHealth);

export const HealthRoutes = router;
