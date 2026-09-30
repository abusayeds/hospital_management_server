import { z } from "zod";
import { objectIdSchema, paginationQuery } from "../../validators/common";
import { AUDIT_ACTIONS } from "./auditLog.model";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const listAuditSchema = z.object({
  query: z
    .object({
      actor: objectIdSchema.optional(),
      // one action, or several separated by commas: ?action=LOGIN_FAILED,ACCOUNT_LOCKED
      action: z
        .string()
        .optional()
        .transform((v) => (v ? v.split(",").map((a) => a.trim()) : undefined))
        .pipe(z.array(z.enum(AUDIT_ACTIONS)).optional()),
      entityType: z.string().trim().max(50).optional(),
      entityId: z.string().trim().max(50).optional(),
      from: dateString.optional(),
      to: dateString.optional(),
      ...paginationQuery,
    })
    .refine((q) => !q.from || !q.to || q.from <= q.to, { message: "'from' must be before 'to'", path: ["from"] }),
});
