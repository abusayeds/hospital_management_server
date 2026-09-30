/* eslint-disable @typescript-eslint/no-explicit-any */

// Internal bookkeeping fields that API clients never need to see
const HIDDEN = ["_id", "__v", "isDeleted", "deletedAt", "deletedBy"];

/**
 * Mongoose document (or lean object) → plain API object with `id` instead of `_id`.
 * Nested ObjectIds serialise as strings in JSON automatically.
 */
export const serialize = <T = Record<string, unknown>>(doc: any): T => {
  if (!doc) return doc;
  const plain = typeof doc.toObject === "function" ? doc.toObject({ versionKey: false }) : { ...doc };
  const out: Record<string, unknown> = { id: String(plain._id), ...plain };
  for (const key of HIDDEN) delete out[key];
  return out as T;
};
