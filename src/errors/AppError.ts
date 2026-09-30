import { TErrorCode } from "../interface/error";

const CODE_BY_STATUS: Record<number, TErrorCode> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  423: "ACCOUNT_LOCKED",
  429: "RATE_LIMITED",
};

// An expected, safe-to-show error (e.g. "Doctor not found"). Anything that is
// not an AppError is treated as a bug and hidden from clients in production.
class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: TErrorCode;
  public readonly details?: unknown;

  constructor(statusCode: number, message: string, code?: TErrorCode, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code ?? CODE_BY_STATUS[statusCode] ?? (statusCode >= 500 ? "INTERNAL_ERROR" : "BAD_REQUEST");
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

export default AppError;
