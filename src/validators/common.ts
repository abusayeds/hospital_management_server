import { z } from "zod";

export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "must be a valid id");

// Bangladeshi mobile: 01XXXXXXXXX (optionally +880 / 880 prefix)
export const bdPhoneSchema = z
  .string()
  .trim()
  .regex(/^(\+?88)?01[3-9]\d{8}$/, "Enter a valid mobile number (01XXXXXXXXX)");

// ?page=2&limit=20 → numbers with safe bounds
export const paginationQuery = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};
