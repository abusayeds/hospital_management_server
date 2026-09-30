/**
 * SHARED CLINICAL RULES — used by BOTH the API and the browser, so the colour a nurse
 * sees while typing is exactly what the server stores. No imports on purpose: this file
 * is copied to frontend/src/lib/clinical-rules.ts by `npm run shared:export`
 * (a test fails if the copy is stale).
 *
 * These are screening thresholds for highlighting, not diagnoses.
 */

export type FlagLevel = "normal" | "abnormal" | "critical";
export type VitalKey = "bp" | "pulse" | "temperatureF" | "respiratoryRate" | "spo2" | "bmi" | "bloodSugar";

export type VitalsInput = {
  bpSystolic?: number | null;
  bpDiastolic?: number | null;
  pulse?: number | null;
  temperatureF?: number | null;
  respiratoryRate?: number | null;
  spo2?: number | null;
  weightKg?: number | null;
  heightCm?: number | null;
  bloodSugar?: { value?: number | null; type?: "fasting" | "random" | null } | null;
};

export type VitalFlag = { key: VitalKey; level: FlagLevel; label: string; labelBn: string };

// Accepted input ranges (anything outside is a typing mistake, not a patient)
export const VITAL_LIMITS = {
  bpSystolic: { min: 50, max: 260, unit: "mmHg" },
  bpDiastolic: { min: 30, max: 160, unit: "mmHg" },
  pulse: { min: 20, max: 250, unit: "/min" },
  temperatureF: { min: 90, max: 110, unit: "°F" },
  respiratoryRate: { min: 5, max: 60, unit: "/min" },
  spo2: { min: 50, max: 100, unit: "%" },
  weightKg: { min: 0.5, max: 300, unit: "kg" },
  heightCm: { min: 30, max: 250, unit: "cm" },
  bloodSugar: { min: 1, max: 40, unit: "mmol/L" },
} as const;

const has = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/** BMI rounded to one decimal, or null when weight/height are missing */
export const computeBmi = (weightKg?: number | null, heightCm?: number | null): number | null => {
  if (!has(weightKg) || !has(heightCm) || heightCm <= 0) return null;
  const m = heightCm / 100;
  return Math.round((weightKg / (m * m)) * 10) / 10;
};

/** One flag per vital that is outside the normal range */
export const flagVitals = (v: VitalsInput): VitalFlag[] => {
  const flags: VitalFlag[] = [];
  const add = (key: VitalKey, level: FlagLevel, label: string, labelBn: string) =>
    flags.push({ key, level, label, labelBn });

  const sys = v.bpSystolic;
  const dia = v.bpDiastolic;
  if (has(sys) || has(dia)) {
    if ((has(sys) && sys >= 180) || (has(dia) && dia >= 120))
      add("bp", "critical", "BP very high", "রক্তচাপ অনেক বেশি");
    else if ((has(sys) && sys < 80) || (has(dia) && dia < 50)) add("bp", "critical", "BP very low", "রক্তচাপ অনেক কম");
    else if ((has(sys) && sys >= 140) || (has(dia) && dia >= 90)) add("bp", "abnormal", "BP high", "রক্তচাপ বেশি");
    else if ((has(sys) && sys < 90) || (has(dia) && dia < 60)) add("bp", "abnormal", "BP low", "রক্তচাপ কম");
  }

  const p = v.pulse;
  if (has(p)) {
    if (p < 40 || p > 130)
      add(
        "pulse",
        "critical",
        p < 40 ? "Pulse very low" : "Pulse very high",
        p < 40 ? "পালস অনেক কম" : "পালস অনেক বেশি",
      );
    else if (p < 60 || p > 100)
      add("pulse", "abnormal", p < 60 ? "Pulse low" : "Pulse high", p < 60 ? "পালস কম" : "পালস বেশি");
  }

  const t = v.temperatureF;
  if (has(t)) {
    if (t >= 103) add("temperatureF", "critical", "High fever", "তীব্র জ্বর");
    else if (t < 95) add("temperatureF", "critical", "Temperature very low", "তাপমাত্রা অনেক কম");
    else if (t >= 100.4) add("temperatureF", "abnormal", "Fever", "জ্বর");
    else if (t < 97) add("temperatureF", "abnormal", "Temperature low", "তাপমাত্রা কম");
  }

  const rr = v.respiratoryRate;
  if (has(rr)) {
    if (rr < 8 || rr > 30) add("respiratoryRate", "critical", "Breathing rate critical", "শ্বাসের হার বিপজ্জনক");
    else if (rr < 12 || rr > 20)
      add(
        "respiratoryRate",
        "abnormal",
        rr < 12 ? "Breathing slow" : "Breathing fast",
        rr < 12 ? "শ্বাস ধীর" : "শ্বাস দ্রুত",
      );
  }

  const s = v.spo2;
  if (has(s)) {
    if (s < 90) add("spo2", "critical", "Oxygen very low", "অক্সিজেন অনেক কম");
    else if (s < 94) add("spo2", "abnormal", "Oxygen low", "অক্সিজেন কম");
  }

  // Asian BMI cut-offs (WHO expert consultation)
  const bmi = computeBmi(v.weightKg, v.heightCm);
  if (bmi !== null) {
    if (bmi < 18.5) add("bmi", "abnormal", "Underweight", "ওজন কম");
    else if (bmi >= 27.5) add("bmi", "abnormal", "Obese", "স্থূলতা");
    else if (bmi >= 23) add("bmi", "abnormal", "Overweight", "ওজন বেশি");
  }

  const sugar = v.bloodSugar?.value;
  if (has(sugar)) {
    const fasting = v.bloodSugar?.type === "fasting";
    if (sugar < 3.0 || sugar > 20)
      add(
        "bloodSugar",
        "critical",
        sugar < 3 ? "Sugar very low" : "Sugar very high",
        sugar < 3 ? "সুগার অনেক কম" : "সুগার অনেক বেশি",
      );
    else if (sugar < 3.9) add("bloodSugar", "abnormal", "Sugar low", "সুগার কম");
    else if (sugar >= (fasting ? 7.0 : 11.1)) add("bloodSugar", "abnormal", "Sugar high", "সুগার বেশি");
  }

  return flags;
};

/** Worst level among the flags (for list badges) */
export const worstLevel = (flags: { level: FlagLevel }[]): FlagLevel =>
  flags.some((f) => f.level === "critical")
    ? "critical"
    : flags.some((f) => f.level === "abnormal")
      ? "abnormal"
      : "normal";

// ---------------------------------------------------------------- lab results

export type LabFlag = "normal" | "high" | "low" | "abnormal" | "critical";
export type LabRange = { normalMin?: number | null; normalMax?: number | null; normalText?: string | null };

/**
 * Flag one lab result against the catalogue range.
 * Numeric: below min → low, above max → high; more than 2× the upper limit or less than
 * half the lower limit → critical (a simple screening rule until per-test critical
 * limits are configured). Text results ("Negative") compare case-insensitively.
 */
export const flagLabValue = (value: string | number | null | undefined, range: LabRange): LabFlag | null => {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const num = typeof value === "number" ? value : Number(String(value).trim());
  const min = range.normalMin;
  const max = range.normalMax;
  if (Number.isFinite(num) && (has(min) || has(max))) {
    if (has(max) && max > 0 && num > max * 2) return "critical";
    if (has(min) && min > 0 && num < min / 2) return "critical";
    if (has(max) && num > max) return "high";
    if (has(min) && num < min) return "low";
    return "normal";
  }
  if (range.normalText) {
    return String(value).trim().toLowerCase() === range.normalText.trim().toLowerCase() ? "normal" : "abnormal";
  }
  return null; // no range to compare against
};

export const formatRange = (range: LabRange & { unit?: string | null }): string => {
  const unit = range.unit ? ` ${range.unit}` : "";
  if (has(range.normalMin) && has(range.normalMax)) return `${range.normalMin} – ${range.normalMax}${unit}`;
  if (has(range.normalMax)) return `< ${range.normalMax}${unit}`;
  if (has(range.normalMin)) return `> ${range.normalMin}${unit}`;
  return range.normalText ?? "";
};

// ---------------------------------------------------------------- prescriptions

export const MEAL_TIMINGS = ["before_meal", "after_meal", "with_meal", "bedtime"] as const;
export type MealTiming = (typeof MEAL_TIMINGS)[number];

const BN_DIGITS = ["০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯"];
export const toBanglaDigits = (text: string | number): string =>
  String(text).replace(/\d/g, (d) => BN_DIGITS[Number(d)]);

export const TIMING_TEXT: Record<MealTiming, { en: string; bn: string }> = {
  before_meal: { en: "before meal", bn: "খাবারের আগে" },
  after_meal: { en: "after meal", bn: "খাবারের পরে" },
  with_meal: { en: "with meal", bn: "খাবারের সাথে" },
  bedtime: { en: "at bedtime", bn: "ঘুমানোর আগে" },
};

// "1+0+1" = morning + noon + night. "½" allowed. Also accepts 4 parts (morning+noon+evening+night).
export const DOSE_PATTERN = /^\s*(?:\d+(?:\.\d+)?|½)(?:\s*\+\s*(?:\d+(?:\.\d+)?|½)){2,3}\s*$/;

const doseAmount = (part: string) => (part.trim() === "½" ? 0.5 : Number(part));

const amountText = (n: number, lang: "en" | "bn") => {
  if (lang === "en") return n === 0.5 ? "½" : String(n);
  if (n === 0.5) return "আধা";
  return `${toBanglaDigits(n)}টা`;
};

/** "1+0+1" → { en: "1 in the morning, 1 at night", bn: "সকালে ১টা, রাতে ১টা" } */
export const describeDose = (pattern: string): { en: string; bn: string } | null => {
  if (!DOSE_PATTERN.test(pattern)) return null;
  const parts = pattern.split("+").map(doseAmount);
  const slots =
    parts.length === 4
      ? [
          { en: "in the morning", bn: "সকালে" },
          { en: "at noon", bn: "দুপুরে" },
          { en: "in the evening", bn: "বিকালে" },
          { en: "at night", bn: "রাতে" },
        ]
      : [
          { en: "in the morning", bn: "সকালে" },
          { en: "at noon", bn: "দুপুরে" },
          { en: "at night", bn: "রাতে" },
        ];
  const en: string[] = [];
  const bn: string[] = [];
  parts.forEach((n, i) => {
    if (!n) return;
    en.push(`${amountText(n, "en")} ${slots[i].en}`);
    bn.push(`${slots[i].bn} ${amountText(n, "bn")}`);
  });
  if (!en.length) return null;
  return { en: en.join(", "), bn: bn.join(", ") };
};

export const describeDuration = (days: number | "continue" | null | undefined): { en: string; bn: string } | null => {
  if (days === "continue") return { en: "continue", bn: "চলবে" };
  if (!days) return null;
  return { en: `${days} day${days === 1 ? "" : "s"}`, bn: `${toBanglaDigits(days)} দিন` };
};

/** Full patient instruction line, e.g. "সকালে ১টা, রাতে ১টা — খাবারের পরে — ৭ দিন" */
export const buildInstructions = (item: {
  dosePattern: string;
  timing?: MealTiming | null;
  durationDays?: number | "continue" | null;
}): { en: string; bn: string } => {
  const dose = describeDose(item.dosePattern) ?? { en: item.dosePattern, bn: item.dosePattern };
  const timing = item.timing ? TIMING_TEXT[item.timing] : null;
  const duration = describeDuration(item.durationDays);
  const join = (lang: "en" | "bn") => [dose[lang], timing?.[lang], duration?.[lang]].filter(Boolean).join(" — ");
  return { en: join("en"), bn: join("bn") };
};

// ------------------------------------------------------------------ prescription safety checks

/**
 * Drug families for the allergy check: an allergy to the family name also matches its members
 * (e.g. "Penicillin" allergy → Amoxicillin). A safety prompt for the doctor, not a full
 * interaction database — the doctor can override with a written reason (audited).
 */
export const DRUG_FAMILIES: Record<string, string[]> = {
  penicillin: ["penicillin", "amoxicillin", "ampicillin", "cloxacillin", "flucloxacillin", "amoxiclav", "piperacillin"],
  cephalosporin: ["cef", "cephalexin", "cephradine"],
  sulfa: ["sulfa", "sulpha", "sulfamethoxazole", "cotrimoxazole", "co-trimoxazole", "sulfasalazine"],
  nsaid: ["ibuprofen", "diclofenac", "naproxen", "aspirin", "ketorolac", "aceclofenac", "mefenamic", "etoricoxib"],
  aspirin: ["aspirin", "acetylsalicylic"],
  macrolide: ["azithromycin", "clarithromycin", "erythromycin"],
  quinolone: ["ciprofloxacin", "levofloxacin", "moxifloxacin", "ofloxacin"],
  paracetamol: ["paracetamol", "acetaminophen"],
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .trim();

/** Which of the patient's allergies this medicine may trigger (by brand, generic or drug family) */
export const allergyMatches = (allergies: string[], medicine: { brandName?: string; genericName?: string }) => {
  const drug = norm(`${medicine.brandName ?? ""} ${medicine.genericName ?? ""}`);
  if (!drug) return [];
  return allergies.filter((allergy) => {
    const a = norm(allergy);
    if (a.length < 3) return false;
    const words = a.split(/\s+/).filter((w) => w.length >= 4 && !["drug", "drugs", "allergy"].includes(w));
    if (words.some((w) => drug.includes(w))) return true;
    return Object.entries(DRUG_FAMILIES).some(
      ([family, members]) => a.includes(family) && members.some((m) => drug.includes(m)),
    );
  });
};

/** Generic names that appear more than once in a prescription (e.g. Napa + Ace = paracetamol twice) */
export const duplicateGenerics = (items: { genericName?: string | null }[]) => {
  const seen = new Map<string, number>();
  for (const i of items) {
    const g = norm(i.genericName ?? "");
    if (g) seen.set(g, (seen.get(g) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([g]) => g);
};
