// All appointment dates are "YYYY-MM-DD" strings in Bangladesh time,
// so "today" never shifts because of the server's timezone.
const TIME_ZONE = "Asia/Dhaka";

export const DAY_NAMES_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const DAY_NAMES_BN = ["রবিবার", "সোমবার", "মঙ্গলবার", "বুধবার", "বৃহস্পতিবার", "শুক্রবার", "শনিবার"];

export const todayInDhaka = (): string => new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date());

export const nowMinutesInDhaka = (): number => {
  const [h, m] = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(new Date())
    .split(":")
    .map(Number);
  return h * 60 + m;
};

export const isValidDateString = (date: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(date) && !isNaN(Date.parse(`${date}T00:00:00Z`));

export const weekdayOf = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay();

export const addDays = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// Start of a Dhaka calendar day as a Date (for createdAt range queries)
export const startOfDhakaDay = (date: string): Date => new Date(`${date}T00:00:00+06:00`);

export const toMinutes = (time: string): number => {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
};

export const toHHMM = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Whole days from `from` to `to` (both YYYY-MM-DD); negative if `to` is earlier */
export const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** "Morning" / "Afternoon" / "Evening" from a session's start time (used on tokens and the TV) */
export const sessionLabel = (startTime: string): { label: string; labelBn: string } => {
  const hour = Math.floor(toMinutes(startTime) / 60);
  if (hour < 12) return { label: "Morning", labelBn: "সকাল" };
  if (hour < 17) return { label: "Afternoon", labelBn: "দুপুর" };
  return { label: "Evening", labelBn: "সন্ধ্যা" };
};

/** Age in whole years on `onDate` (YYYY-MM-DD), from a Date of birth */
export const ageOn = (dob: Date, onDate: string = todayInDhaka()): number => {
  const [y, m, d] = onDate.split("-").map(Number);
  let age = y - dob.getUTCFullYear();
  if (m < dob.getUTCMonth() + 1 || (m === dob.getUTCMonth() + 1 && d < dob.getUTCDate())) age -= 1;
  return Math.max(0, age);
};
