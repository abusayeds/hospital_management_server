import { NextFunction, Request, Response } from "express";
import { AnyZodObject, z } from "zod";

/**
 * Validates req.body / req.query / req.params against a Zod schema shaped like
 *   z.object({ body: ..., query: ..., params: ... })   (each part optional)
 *
 * On success the parsed values replace the raw ones, so controllers receive
 * trimmed, coerced data with unknown fields stripped. On failure the ZodError
 * goes to the global error handler, which answers 400 VALIDATION_ERROR.
 */
const validateRequest = (schema: AnyZodObject) => async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const parsed = (await schema.parseAsync({
      body: req.body,
      query: req.query,
      params: req.params,
    })) as { body?: unknown; query?: Record<string, unknown>; params?: Record<string, string> };

    if ("body" in schema.shape) req.body = parsed.body;
    // query and params are replaced key-by-key so this also works on Express 5
    if ("query" in schema.shape) replaceContents(req.query, parsed.query);
    if ("params" in schema.shape) replaceContents(req.params, parsed.params);
    next();
  } catch (error) {
    next(error);
  }
};

const replaceContents = (target: Record<string, unknown>, source: Record<string, unknown> = {}) => {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
};

// Small reusable pieces for validators
export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "must be a valid id");

export default validateRequest;
