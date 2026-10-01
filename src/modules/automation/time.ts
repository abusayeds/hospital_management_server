import { DAY_NAMES_BN, DAY_NAMES_EN, toHHMM, toMinutes, weekdayOf } from "../../utils/date";

/**
 * Time helpers for automation. Every function takes `now` so planners and tests can run at any
 * moment ("what would happen tomorrow at 18:00?"). Stored times are UTC Dates; everything a human
 * reads is Asia/Dhaka (UTC+6, no daylight saving).
 */

const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;

/** YYYY-MM-DD in Dhaka for an instant */
export const dhakaDate = (now: Date): string => new Date(now.getTime() + DHAKA_OFFSET_MS).toISOString().slice(0, 10);

/** Minutes since Dhaka midnight for an instant */
export const dhakaMinutes = (now: Date): number => {
  const d = new Date(now.getTime() + DHAKA_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

/** The instant of a Dhaka wall-clock date + time ("2026-10-02", "18:00") */
export const atDhaka = (date: string, time: string): Date => new Date(`${date}T${time}:00+06:00`);

export const addMinutes = (d: Date, minutes: number) => new Date(d.getTime() + minutes * 60_000);

/** Is `now` inside the quiet window? The window may cross midnight (21:00 → 09:00). */
export const inQuietHours = (now: Date, start: string, end: string): boolean => {
  const m = dhakaMinutes(now);
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (s === e) return false;
  return s < e ? m >= s && m < e : m >= s || m < e;
};

/** First instant at or after `now` that is outside the quiet window */
export const quietHoursEndAfter = (now: Date, start: string, end: string): Date => {
  if (!inQuietHours(now, start, end)) return now;
  const today = dhakaDate(now);
  const endToday = atDhaka(today, end);
  if (endToday > now) return endToday;
  const [y, mo, d] = today.split("-").map(Number);
  const tomorrow = new Date(Date.UTC(y, mo - 1, d + 1)).toISOString().slice(0, 10);
  return atDhaka(tomorrow, end);
};

/** Start of the next Dhaka day (when daily limits reset) */
export const nextDhakaMidnight = (now: Date): Date => {
  const [y, mo, d] = dhakaDate(now).split("-").map(Number);
  return atDhaka(new Date(Date.UTC(y, mo - 1, d + 1)).toISOString().slice(0, 10), "00:00");
};

export const startOfDhakaDayFor = (now: Date): Date => atDhaka(dhakaDate(now), "00:00");

// ------------------------------------------------------------------ formatting for messages

const BN_DIGITS = "০১২৩৪৫৬৭৮৯";
export const toBanglaDigits = (s: string) => s.replace(/\d/g, (d) => BN_DIGITS[Number(d)]);

const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_BN = [
  "জানুয়ারি",
  "ফেব্রুয়ারি",
  "মার্চ",
  "এপ্রিল",
  "মে",
  "জুন",
  "জুলাই",
  "আগস্ট",
  "সেপ্টেম্বর",
  "অক্টোবর",
  "নভেম্বর",
  "ডিসেম্বর",
];

/** "Fri, 2 Oct" / "২ অক্টোবর, শুক্রবার" (digits are converted later, per hospital setting) */
export const formatDateFor = (date: string, lang: "bn" | "en"): string => {
  const [, m, d] = date.split("-").map(Number);
  const wd = weekdayOf(date);
  return lang === "bn"
    ? `${d} ${MONTHS_BN[m - 1]}, ${DAY_NAMES_BN[wd]}`
    : `${DAY_NAMES_EN[wd].slice(0, 3)}, ${d} ${MONTHS_EN[m - 1]}`;
};

/** "10:30 AM" / "সকাল 10:30" */
export const formatTimeFor = (time: string, lang: "bn" | "en"): string => {
  const minutes = toMinutes(time);
  const h = Math.floor(minutes / 60);
  if (lang === "en") {
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(minutes % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  }
  const part = h < 5 ? "রাত" : h < 12 ? "সকাল" : h < 15 ? "দুপুর" : h < 18 ? "বিকাল" : h < 20 ? "সন্ধ্যা" : "রাত";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${part} ${toHHMM(h12 * 60 + (minutes % 60)).replace(/^0/, "")}`;
};
