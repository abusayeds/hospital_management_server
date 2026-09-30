import { Request, Response } from "express";
import catchAsync from "../../utils/catchAsync";
import sendResponse from "../../utils/sendResponse";
import { userService } from "./user.service";

const list = catchAsync(async (req: Request, res: Response) => {
  const { items, pagination } = await userService.listUsers(req.query as never);
  sendResponse(res, { statusCode: 200, success: true, message: "Users", data: items, pagination });
});

const summary = catchAsync(async (_req: Request, res: Response) => {
  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "User summary",
    data: await userService.getUserSummary(),
  });
});

const get = catchAsync(async (req: Request, res: Response) => {
  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "User",
    data: await userService.getUser(req.params.id),
  });
});

const create = catchAsync(async (req: Request, res: Response) => {
  const result = await userService.createUser(req, req.body);
  sendResponse(res, { statusCode: 201, success: true, message: "User created", data: result });
});

const update = catchAsync(async (req: Request, res: Response) => {
  const user = await userService.updateUser(req, req.params.id, req.body);
  sendResponse(res, { statusCode: 200, success: true, message: "User updated", data: user });
});

const deactivate = catchAsync(async (req: Request, res: Response) => {
  const user = await userService.setActive(req, req.params.id, false);
  sendResponse(res, { statusCode: 200, success: true, message: "User deactivated", data: user });
});

const activate = catchAsync(async (req: Request, res: Response) => {
  const user = await userService.setActive(req, req.params.id, true);
  sendResponse(res, { statusCode: 200, success: true, message: "User activated", data: user });
});

const resetPassword = catchAsync(async (req: Request, res: Response) => {
  const result = await userService.resetPassword(req, req.params.id);
  sendResponse(res, { statusCode: 200, success: true, message: "Password reset", data: result });
});

export const userController = { list, summary, get, create, update, deactivate, activate, resetPassword };
