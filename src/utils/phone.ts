import AppError from "../errors/AppError";

/**
 * Bangladeshi mobile numbers are stored in ONE format: +8801XXXXXXXXX (E.164).
 * Staff type them many ways — 01711-222333, 8801711222333, +880 1711 222333 —
 * and they must all match the same patient.
 */
const BD_MOBILE = /^01[3-9]\d{8}$/;

/** Any accepted spelling → "+8801XXXXXXXXX", or null if it is not a valid BD mobile */
export const toE164Bd = (input: string): string | null => {
  const digits = String(input)
    .replace(/\D/g, "")
    .replace(/^0*88(?=01)/, "");
  return BD_MOBILE.test(digits) ? `+88${digits}` : null;
};

export const normalizeBdPhone = (input: string, field = "phone"): string => {
  const phone = toE164Bd(input);
  if (!phone) {
    throw new AppError(400, "Enter a valid Bangladeshi mobile number (01XXXXXXXXX).", "VALIDATION_ERROR", [
      { path: `body.${field}`, message: "must be a Bangladeshi mobile number like 01711222333" },
    ]);
  }
  return phone;
};

/** "+8801711222333" → "01711-222333" (how staff read numbers aloud) */
export const formatBdPhone = (e164: string): string => {
  const local = e164.replace(/^\+88/, "");
  return local.length === 11 ? `${local.slice(0, 5)}-${local.slice(5)}` : local;
};

/**
 * Turns partial typing into a stored-phone PREFIX for as-you-type search:
 *   "0171" → "+880171", "171122" → "+880171122", "88017" → "+88017"
 * Returns null if the text is not phone-like (fewer than 3 digits or has letters).
 */
export const phoneSearchPrefix = (q: string): string | null => {
  if (/[a-zঀ-৿]/i.test(q)) return null;
  const digits = q.replace(/\D/g, "");
  if (digits.length < 3) return null;
  if (digits.startsWith("880")) return `+${digits}`;
  if (digits.startsWith("0")) return `+88${digits}`;
  return `+880${digits}`;
};
