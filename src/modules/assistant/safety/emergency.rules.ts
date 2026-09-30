/**
 * EMERGENCY RULES — checked in code BEFORE the AI, on every patient message (Bangla, English and
 * Banglish). A match never waits for a model: the patient immediately gets the emergency
 * instructions and staff get a red alert in the inbox.
 *
 * Admins can add words in Hospital Settings → "Assistant emergency keywords" (plain phrases,
 * matched case-insensitively). Keep this built-in list conservative but broad: a false alarm costs
 * a staff member a glance; a missed emergency can cost a life.
 */
export type EmergencyRule = { label: string; selfHarm?: boolean; pattern: RegExp };

export const EMERGENCY_RULES: EmergencyRule[] = [
  {
    label: "chest pain",
    pattern:
      /বুকে?(\s+\S+){0,2}\s*(ব্যথা|ব্যাথা|চাপ|যন্ত্রণা)|chest(\s+\w+){0,2}\s*(pain|tightness)|\bbuke?(\s+\w+){0,2}\s+(betha|batha|bytha|byatha|chap)/i,
  },
  {
    label: "heart attack",
    pattern: /হার্ট\s*(অ্যাটাক|এটাক)|heart\s*attack|heart\s*atta?ck/i,
  },
  {
    label: "breathing difficulty",
    pattern:
      /শ্বাস(\s+\S+){0,3}\s*(কষ্ট|বন্ধ)|শ্বাস\s*নিতে\s*পার(ছি|ছে|ছেন)\s*না|দম\s*বন্ধ|can'?t\s*breathe|cannot\s*breathe|difficulty\s*breathing|shortness\s*of\s*breath|\b(shash|shas|swas)(\s+\w+){0,3}\s+(kosto|koshto)|nite\s*parchi\s*na|dom\s*bondho/i,
  },
  {
    label: "unconscious",
    pattern:
      /অজ্ঞান|জ্ঞান\s*(হারা|নেই|ফিরছে\s*না)|unconscious|not\s*responding|fainted|passed\s*out|(o|a)ggan|gyan\s*nai/i,
  },
  {
    label: "stroke signs",
    pattern:
      /স্ট্রোক|মুখ\s*(বেঁকে|বাঁকা)|হাত[-\s]*পা\s*অবশ|stroke|face\s*droop|slurred\s*speech|paraly[sz]|প্যারালাইসিস|mukh\s*beke/i,
  },
  {
    label: "heavy bleeding",
    pattern:
      /প্রচুর\s*রক্ত|রক্ত\s*(বন্ধ\s*হচ্ছে\s*না|পড়ছে|বমি)|রক্তপাত|heavy\s*bleeding|bleeding\s*(a\s*lot|heavily|won'?t\s*stop)|vomiting\s*blood|(prochur|onek)\s*rokto|rokto\s*(porche|bondho\s*hocche\s*na)/i,
  },
  { label: "seizure", pattern: /খিঁচুনি|খিচুনি|seizure|convulsion|khichuni/i },
  {
    label: "poisoning",
    pattern: /বিষ\s*(খে|পান)|কীটনাশক|poison|overdose|swallowed\s*(pills|poison)|bish\s*kheye|kitnashok/i,
  },
  {
    label: "severe injury",
    pattern:
      /দুর্ঘটনা|এক্সিডেন্ট|মাথায়\s*আঘাত|পুড়ে\s*গেছে|\baccident\b|head\s*injury|severe\s*(burn|injury)|bone\s*sticking|accident\s*hoyeche/i,
  },
  {
    label: "pregnancy emergency",
    pattern:
      /গর্ভাবস্থায়\s*রক্ত|প্রসব\s*ব্যথা|পানি\s*ভেঙে|bleeding\s*(in|during)\s*pregnancy|pregnan\w*\s*(bleeding|pain)|labou?r\s*pain|water\s*(broke|broken)|prosob\s*betha/i,
  },
  {
    label: "self-harm",
    selfHarm: true,
    pattern:
      /আত্মহত্যা|মরে\s*যেতে\s*চাই|বাঁচতে\s*চাই\s*না|নিজেকে\s*শেষ|suicid|kill\s*myself|end\s*my\s*life|want\s*to\s*die|self[-\s]*harm|(more|mora)\s*jete\s*chai|atmohotta/i,
  },
];

export const detectEmergency = (text: string, extraKeywords: string[] = []): EmergencyRule | null => {
  const hit = EMERGENCY_RULES.find((r) => r.pattern.test(text));
  if (hit) return hit;
  const lower = text.toLowerCase();
  const extra = extraKeywords.find((k) => k.trim() && lower.includes(k.trim().toLowerCase()));
  return extra ? { label: `keyword: ${extra}`, pattern: /$^/ } : null;
};
