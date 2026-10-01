import express from "express";
import { authenticate } from "../../middlewares/authenticate";
import { changePasswordLimiter, loginLimiter, refreshLimiter } from "../../middlewares/rateLimiter";
import validateRequest from "../../middlewares/validateRequest";
import { authController } from "./auth.controller";
import { changePasswordSchema, loginSchema } from "./auth.validation";

const router = express.Router();
// A user who must change their password may still reach these few routes
const pendingOk = authenticate({ allowPendingPasswordChange: true });

router.post("/login", loginLimiter, validateRequest(loginSchema), authController.login);
router.post("/refresh", refreshLimiter, authController.refresh);
// Logout works even with an expired access token (it uses the refresh cookie)
router.post("/logout", authController.logout);
router.post("/logout-all", pendingOk, authController.logoutAll);
router.get("/me", pendingOk, authController.me);
router.post(
  "/change-password",
  changePasswordLimiter,
  pendingOk,
  validateRequest(changePasswordSchema),
  authController.changePassword,
);

export const AuthRoutes = router;
