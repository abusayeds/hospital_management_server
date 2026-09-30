import { Request, Response } from "express";
import catchAsync from "../../utils/catchAsync";
import sendResponse from "../../utils/sendResponse";
import { authService } from "./auth.service";
import { clearAuthCookies, REFRESH_COOKIE, setAuthCookies } from "./tokens";

// Tokens only ever travel in httpOnly cookies — they are never in a response body.

const login = catchAsync(async (req: Request, res: Response) => {
  const { user, accessToken, refreshToken } = await authService.login(req.body.email, req.body.password, req);
  setAuthCookies(res, accessToken, refreshToken);
  sendResponse(res, { statusCode: 200, success: true, message: "Signed in", data: { user } });
});

const refresh = catchAsync(async (req: Request, res: Response) => {
  try {
    const { user, accessToken, refreshToken } = await authService.refresh(req.cookies?.[REFRESH_COOKIE], req);
    setAuthCookies(res, accessToken, refreshToken);
    sendResponse(res, { statusCode: 200, success: true, message: "Session refreshed", data: { user } });
  } catch (err) {
    clearAuthCookies(res);
    throw err;
  }
});

const logout = catchAsync(async (req: Request, res: Response) => {
  await authService.logout(req, req.cookies?.[REFRESH_COOKIE]);
  // Clearing cookies even when no session was found makes logout always succeed
  clearAuthCookies(res);
  sendResponse(res, { statusCode: 200, success: true, message: "Signed out", data: null });
});

const logoutAll = catchAsync(async (req: Request, res: Response) => {
  await authService.logoutAll(req);
  clearAuthCookies(res);
  sendResponse(res, { statusCode: 200, success: true, message: "Signed out on all devices", data: null });
});

const me = catchAsync(async (req: Request, res: Response) => {
  const user = await authService.getMe(req.user!.id);
  sendResponse(res, { statusCode: 200, success: true, message: "Current user", data: { user } });
});

const changePassword = catchAsync(async (req: Request, res: Response) => {
  const user = await authService.changePassword(req, req.body.currentPassword, req.body.newPassword);
  sendResponse(res, { statusCode: 200, success: true, message: "Password changed", data: { user } });
});

export const authController = { login, refresh, logout, logoutAll, me, changePassword };
