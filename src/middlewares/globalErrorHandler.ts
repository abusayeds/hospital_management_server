import { ErrorRequestHandler } from "express";
import mongoose from "mongoose";
import { ZodError } from "zod";
import { isProduction } from "../config/env";
import AppError from "../errors/AppError";
import handleCastError from "../errors/handleCastError";
import handleDuplicateError from "../errors/handleDuplicateError";
import handleValidationError from "../errors/handleValidationError";
import handleZodError from "../errors/handleZodError";
import { TErrorResponse, TNormalizedError } from "../interface/error";
import { logger } from "../utils/logger";

// Turns any thrown error into our { statusCode, code, message, details } shape
export const normalizeError = (err: unknown): TNormalizedError => {
  if (err instanceof AppError) {
    return { statusCode: err.statusCode, code: err.code, message: err.message, details: err.details };
  }
  if (err instanceof ZodError) return handleZodError(err);
  if (err instanceof mongoose.Error.ValidationError) return handleValidationError(err);
  if (err instanceof mongoose.Error.CastError) return handleCastError(err);

  const e = err as { code?: number; type?: string; name?: string; keyValue?: Record<string, unknown> };
  if (e?.code === 11000) return handleDuplicateError({ code: 11000, keyValue: e.keyValue });

  // Errors raised by express.json() before our code runs
  if (e?.type === "entity.parse.failed") {
    return { statusCode: 400, code: "INVALID_JSON", message: "Request body is not valid JSON." };
  }
  if (e?.type === "entity.too.large") {
    return { statusCode: 413, code: "PAYLOAD_TOO_LARGE", message: "Request body is too large." };
  }
  if (e?.name === "JsonWebTokenError" || e?.name === "TokenExpiredError") {
    return {
      statusCode: 401,
      code: "UNAUTHORIZED",
      message: "Your session is invalid or has expired. Please sign in again.",
    };
  }

  return { statusCode: 500, code: "INTERNAL_ERROR", message: (err as Error)?.message || "Something went wrong." };
};

// Registered last in app.ts. Every error in the API leaves through here, so
// clients always receive: { error: { code, message, details } }
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const globalErrorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const normalized = normalizeError(err);
  const isServerError = normalized.statusCode >= 500;

  if (isServerError) {
    logger.error({ err, reqId: req.id, url: req.originalUrl }, "Unhandled error");
  }

  const body: TErrorResponse = {
    error: {
      code: normalized.code,
      // Internal messages can leak implementation details, so hide them in production
      message: isServerError && isProduction ? "Something went wrong. Please try again later." : normalized.message,
      details: isServerError && isProduction ? undefined : normalized.details,
    },
  };
  if (isServerError && !isProduction) {
    (body.error as Record<string, unknown>).stack = (err as Error)?.stack;
  }

  res.status(normalized.statusCode).json(body);
};

export default globalErrorHandler;
