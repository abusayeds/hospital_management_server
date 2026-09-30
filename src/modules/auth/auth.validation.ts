import { z } from "zod";
import { passwordSchema } from "../../validators/password";

// z.string() rejects objects, so {"email": {"$gt": ""}} fails here even if it got past the sanitizer
export const loginSchema = z.object({
  body: z.object({
    email: z.string({ required_error: "Email is required" }).trim().toLowerCase().email("Enter a valid email address"),
    password: z.string({ required_error: "Password is required" }).min(1, "Password is required").max(128),
  }),
});

export const changePasswordSchema = z.object({
  body: z.object({
    currentPassword: z
      .string({ required_error: "Current password is required" })
      .min(1, "Current password is required"),
    newPassword: passwordSchema,
  }),
});
