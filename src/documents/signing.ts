import crypto from "crypto";
import { env } from "../config/env";

/**
 * SIGNED DOCUMENT CODES — what the QR on a printed prescription or lab report carries.
 *
 * code = "<number>.<signature>", e.g. "RX-000123.k3J9xQ2mTa". The signature is an HMAC of the
 * number, so nobody can print a fake prescription with a guessed number that "verifies".
 * The code holds no patient data; the public verify page shows only what is safe to show.
 */

const key = () =>
  env.DOCUMENT_SIGNING_KEY ?? crypto.createHmac("sha256", env.JWT_SECRET_KEY).update("document-signing").digest("hex");

const signatureOf = (documentNo: string) =>
  crypto.createHmac("sha256", key()).update(documentNo).digest("base64url").slice(0, 12);

export const signDocumentCode = (documentNo: string) => `${documentNo}.${signatureOf(documentNo)}`;

/** The document number when the code is genuine, otherwise null */
export const verifyDocumentCode = (code: string): string | null => {
  const dot = code.lastIndexOf(".");
  if (dot <= 0) return null;
  const documentNo = code.slice(0, dot);
  const given = Buffer.from(code.slice(dot + 1));
  const expected = Buffer.from(signatureOf(documentNo));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected) ? documentNo : null;
};

/** The public page the QR opens */
export const verifyUrl = (code: string) =>
  `${(env.PUBLIC_APP_URL ?? env.CLIENT_URL[0]).replace(/\/$/, "")}/verify/${encodeURIComponent(code)}`;
