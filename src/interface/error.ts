export type TErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_ERROR"
  | "INVALID_ID"
  | "INVALID_JSON"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "DUPLICATE_KEY"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR"
  // auth (Phase 2)
  | "INVALID_CREDENTIALS"
  | "ACCOUNT_LOCKED"
  | "ACCOUNT_DISABLED"
  | "PASSWORD_CHANGE_REQUIRED"
  | "SESSION_EXPIRED"
  | "SESSION_REVOKED"
  | "CSRF_REJECTED"
  // clinical (Phase 4)
  | "VISIT_OPEN"
  | "VISIT_CLOSED"
  | "ALLERGY_CONFLICT"
  | "FOUR_EYES_REQUIRED"
  // AI layer (Phase 4)
  | "AI_NOT_CONFIGURED"
  | "AI_UNAVAILABLE"
  | "AI_INVALID_OUTPUT";

// One field-level problem, e.g. { path: "body.phone", message: "Required" }
export type TFieldError = { path: string; message: string };

// Result of translating a library error (Zod, Mongoose, Mongo) into our format
export type TNormalizedError = {
  statusCode: number;
  code: TErrorCode;
  message: string;
  details?: unknown;
};

// The only error shape the API ever sends: { error: { code, message, details } }
export type TErrorResponse = {
  error: { code: TErrorCode; message: string; details?: unknown };
};
