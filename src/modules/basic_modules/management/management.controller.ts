import type { Request, Response } from "express";
import httpStatus from "http-status";
import sanitizeHtml from "sanitize-html";

import { AboutModel, PrivacyModel, TermsModel } from "./management.model";
import AppError from "../../../errors/AppError";
import catchAsync from "../../../utils/catchAsync";
import sendResponse from "../../../utils/sendResponse";

// Sanitize options for description content
const sanitizeOptions = {
  allowedTags: [
    "b",
    "i",
    "em",
    "strong",
    "a",
    "p",
    "br",
    "ul",
    "ol",
    "li",
    "blockquote",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "code",
    "pre",
    "img",
  ],
  allowedAttributes: { a: ["href", "target"], img: ["src", "alt"] },
  allowedIframeHostnames: ["www.youtube.com"],
};
const createManagement = catchAsync(async (req: Request, res: Response) => {
  const { description, type } = req.body;
  const validTypes = ["terms", "about", "privacy"];
  if (!validTypes.includes(type)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Invalid type provided. Accepted type: 'terms', 'about', or 'privacy' in body",
    );
  }
  const sanitizedContent = sanitizeHtml(description, sanitizeOptions);
  if (!sanitizedContent) {
    throw new AppError(httpStatus.BAD_REQUEST, "Description is required!");
  }
  const model = type === "terms" ? TermsModel : type === "about" ? AboutModel : PrivacyModel;
  const result = await model.updateOne({}, { description: sanitizedContent }, { upsert: true });
  sendResponse(res, {
    success: true,
    statusCode: httpStatus.CREATED,
    message: `${type.charAt(0).toUpperCase() + type.slice(1)} description updated successfully.`,
    data: result,
  });
});
const getManagement = catchAsync(async (req: Request, res: Response) => {
  const { type } = req.params;
  const validTypes = ["terms", "about", "privacy"];
  if (!validTypes.includes(type)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid type provided. Accepted type: 'terms', 'about', or 'privacy'");
  }
  const model = type === "terms" ? TermsModel : type === "about" ? AboutModel : PrivacyModel;
  const result = await model.findOne({}).lean();
  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: `${type.charAt(0).toUpperCase() + type.slice(1)} description retrieved successfully.`,
    data: result,
  });
});
export const managementController = {
  createManagement,
  getManagement,
};
