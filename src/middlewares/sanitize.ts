import { NextFunction, Request, Response } from "express";
import { logger } from "../utils/logger";

// Keys that let a client smuggle MongoDB operators ({ "$gt": "" }), reach into
// nested paths ("profile.role") or pollute Object.prototype.
const isDangerousKey = (key: string): boolean =>
  key.startsWith("$") || key.includes(".") || key === "__proto__" || key === "constructor" || key === "prototype";

/**
 * Recursively deletes dangerous keys from an object IN PLACE and returns the
 * removed key paths. Mutating in place (instead of reassigning req.query) keeps
 * this compatible with Express 5, where req.query is a read-only getter — the
 * reason express-mongo-sanitize breaks there.
 */
export const stripDangerousKeys = (value: unknown, path = "", removed: string[] = []): string[] => {
  if (Array.isArray(value)) {
    value.forEach((item, i) => stripDangerousKeys(item, `${path}[${i}]`, removed));
  } else if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      const keyPath = path ? `${path}.${key}` : key;
      if (isDangerousKey(key)) {
        delete (value as Record<string, unknown>)[key];
        removed.push(keyPath);
      } else {
        stripDangerousKeys((value as Record<string, unknown>)[key], keyPath, removed);
      }
    }
  }
  return removed;
};

export const sanitizeRequest = (req: Request, _res: Response, next: NextFunction) => {
  const removed = [
    ...stripDangerousKeys(req.body, "body"),
    ...stripDangerousKeys(req.params, "params"),
    ...stripDangerousKeys(req.query, "query"),
  ];
  if (removed.length) {
    logger.warn(
      { reqId: req.id, url: req.originalUrl, removed },
      "Stripped suspicious keys from request (possible NoSQL injection)",
    );
  }
  next();
};
