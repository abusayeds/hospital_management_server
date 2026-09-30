import { z } from "zod";
import { ROLES } from "../../config/permissions";
import { bdPhoneSchema, objectIdSchema, paginationQuery } from "../../validators/common";
import { passwordSchema } from "../../validators/password";

const idParams = z.object({ id: objectIdSchema });

export const listUsersSchema = z.object({
  query: z.object({
    search: z.string().trim().max(100).optional(),
    role: z.enum(ROLES).optional(),
    status: z.enum(["active", "inactive"]).optional(),
    ...paginationQuery,
  }),
});

export const userIdSchema = z.object({ params: idParams });

export const createUserSchema = z.object({
  body: z.object({
    name: z.string({ required_error: "Name is required" }).trim().min(2, "Name must be at least 2 characters").max(100),
    email: z.string({ required_error: "Email is required" }).trim().toLowerCase().email("Enter a valid email address"),
    phone: bdPhoneSchema.optional().or(z.literal("").transform(() => undefined)),
    role: z.enum(ROLES, { errorMap: () => ({ message: "Choose a role" }) }),
    // Optional: the server generates one if the admin leaves it empty
    temporaryPassword: passwordSchema.optional(),
  }),
});

export const updateUserSchema = z.object({
  params: idParams,
  body: z
    .object({
      name: z.string().trim().min(2, "Name must be at least 2 characters").max(100),
      email: z.string().trim().toLowerCase().email("Enter a valid email address"),
      phone: bdPhoneSchema.or(z.literal("")),
      role: z.enum(ROLES),
    })
    .partial()
    .strict("Only name, email, phone and role can be changed here")
    .refine((b) => Object.keys(b).length > 0, "Nothing to update"),
});
