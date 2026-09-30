import { z } from "zod";

// Hospital password policy: at least 8 characters, with letters AND numbers.
// Messages are written for staff, not developers.
export const passwordSchema = z
  .string({ required_error: "Password is required" })
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password is too long")
  .regex(/[A-Za-z]/, "Password must contain at least one letter")
  .regex(/\d/, "Password must contain at least one number");

// Readable temporary password, e.g. "Tl-kq7m-9xa2": letters + numbers, no look-alike characters
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const generateTemporaryPassword = (random: (max: number) => number): string => {
  const chunk = () => Array.from({ length: 4 }, () => ALPHABET[random(ALPHABET.length)]).join("");
  let pwd = "";
  // Guarantee at least one digit so it always satisfies the policy
  while (!/\d/.test(pwd)) pwd = `Tl-${chunk()}-${chunk()}`;
  return pwd;
};
