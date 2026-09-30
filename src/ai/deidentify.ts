/**
 * DE-IDENTIFICATION — nothing that identifies a patient may reach an AI provider.
 *
 * Features build their input from clinical facts only (age, gender, findings, results) and
 * never add name, phone, NID, address or patient code. Two extra safety nets live here:
 *  1. scrubText(): free text written by staff can still contain a name or a phone number
 *     ("Rahima's husband called from 017…"), so it is cleaned before sending;
 *  2. assertDeidentified(): the final prompt is checked for the patient's identifiers and the
 *     request is refused if any slipped through (fail closed).
 */

const PATTERNS: [RegExp, string][] = [
  [/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]"],
  [/(?:\+?880|0)1[3-9]\d{2}[-\s]?\d{6}\b/g, "[phone]"], // Bangladesh mobile numbers
  [/\bTL-?\d{3,}\b/gi, "[patient-id]"], // our patient codes
  [/\b\d{10}\b|\b\d{13}\b|\b\d{17}\b/g, "[id-number]"], // NID lengths (10 / 13 / 17 digits)
];

/** Words of the patient's identifiers worth hunting for (names split into parts, short parts skipped) */
export const identifierTokens = (identifiers: (string | null | undefined)[]) =>
  identifiers
    .filter((v): v is string => Boolean(v && v.trim()))
    .flatMap((v) => [v.trim(), ...v.trim().split(/\s+/)])
    .filter((t) => t.replace(/\D/g, "").length >= 6 || t.length >= 3)
    .filter((t) => !["md", "mst", "mrs", "mr", "the", "and"].includes(t.toLowerCase()));

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const scrubText = (text: string, identifiers: (string | null | undefined)[] = []) => {
  let out = text;
  for (const [rx, label] of PATTERNS) out = out.replace(rx, label);
  for (const token of identifierTokens(identifiers).sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`(?<![\\p{L}\\d])${escapeRegex(token)}(?![\\p{L}\\d])`, "giu"), "[name]");
  }
  return out;
};

/** Throws if any identifier is still present in the text about to be sent */
export const assertDeidentified = (text: string, identifiers: (string | null | undefined)[]) => {
  const lower = text.toLowerCase();
  const leaked = identifierTokens(identifiers).filter((t) => {
    const rx = new RegExp(`(?<![\\p{L}\\d])${escapeRegex(t.toLowerCase())}(?![\\p{L}\\d])`, "u");
    return rx.test(lower);
  });
  if (leaked.length) throw new Error("De-identification check failed: an identifier is still in the AI input.");
};
