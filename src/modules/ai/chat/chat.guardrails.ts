import { HOSPITAL_ADDRESS, HOSPITAL_EMERGENCY_PHONE } from "../../../config";
const EMERGENCY_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /বুকে\s*(ব্যথা|ব্যাথা|চাপ)|chest\s*pain|buke\s*(betha|batha|bytha)/i, label: "chest pain" },
  {
    pattern:
      /শ্বাস\s*(কষ্ট|নিতে\s*পারছ)|can'?t\s*breathe|difficulty\s*breathing|shortness\s*of\s*breath|shash\s*kosto/i,
    label: "breathing difficulty",
  },
  { pattern: /অজ্ঞান|জ্ঞান\s*হারা|unconscious|fainted|passed\s*out|oggan/i, label: "unconscious" },
  { pattern: /স্ট্রোক|stroke|মুখ\s*বেঁকে|paralys|প্যারালাইসিস/i, label: "stroke signs" },
  { pattern: /হার্ট\s*অ্যাটাক|heart\s*attack/i, label: "heart attack" },
  {
    pattern: /প্রচুর\s*রক্ত|রক্ত\s*বন্ধ\s*হচ্ছে\s*না|heavy\s*bleeding|bleeding\s*(a\s*lot|heavily)/i,
    label: "heavy bleeding",
  },
  { pattern: /খিঁচুনি|seizure|convulsion/i, label: "seizure" },
  { pattern: /বিষ\s*খে|poison|overdose/i, label: "poisoning" },
  { pattern: /আত্মহত্যা|মরে\s*যেতে\s*চাই|suicid|kill\s*myself/i, label: "self-harm" },
];

export const detectEmergency = (text: string): string | null => {
  const hit = EMERGENCY_PATTERNS.find((p) => p.pattern.test(text));
  return hit ? hit.label : null;
};

export const buildEmergencyReply = (): string =>
  [
    "⚠️ আপনার বর্ণনা শুনে এটি জরুরি অবস্থা মনে হচ্ছে।",
    `দেরি না করে এখনই হাসপাতালের Emergency বিভাগে চলে আসুন (${HOSPITAL_ADDRESS}) অথবা ফোন করুন: ${HOSPITAL_EMERGENCY_PHONE}।`,
    "আমাদের একজন staff যত দ্রুত সম্ভব আপনার সাথে যোগাযোগ করবেন।",
    "",
    "⚠️ This sounds like an emergency. Please come to our Emergency department immediately " +
      `or call ${HOSPITAL_EMERGENCY_PHONE}. I am the Testo Life assistant and cannot give medical advice.`,
  ].join("\n");
