import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "crypto";
import { env } from "../config/env";

/**
 * Field-level encryption for sensitive identifiers (national ID).
 * AES-256-GCM: every value gets a fresh random 12-byte IV, and the 16-byte auth
 * tag makes any tampering fail on decrypt. Stored as "v1:<iv>:<tag>:<ciphertext>"
 * (base64) — the version prefix allows rotating algorithms or keys later.
 * A database dump without ENCRYPTION_KEY reveals nothing.
 */
const ALGORITHM = "aes-256-gcm";
const key = () => Buffer.from(env.ENCRYPTION_KEY, "hex");

export const encryptField = (plain: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(":");
};

export const decryptField = (stored: string): string => {
  const [version, iv, tag, ciphertext] = stored.split(":");
  if (version !== "v1") throw new Error("Unknown encryption format");
  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
};

/** "1234567890123" → "•••••••••0123" (the only form an NID ever leaves the API in) */
export const maskTail = (value: string, visible = 4): string =>
  value.length <= visible ? value : "•".repeat(value.length - visible) + value.slice(-visible);

/** Constant-time string comparison (secrets such as the TV display key) — no timing leak */
export const safeEqual = (a: string, b: string): boolean => {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
};
