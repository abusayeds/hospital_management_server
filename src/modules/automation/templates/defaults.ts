import type { IMessageTemplate, TemplateVariable } from "../models/template.model";

/**
 * DEFAULT TEMPLATES — one per rule, Bangla + English. Inserted once; the admin edits them afterwards.
 * Rules: no lab values, diagnoses, medicines or other patients' details — ever. First names only.
 * whatsappTemplateName is the Meta-approved template used outside the 24-hour window; whatsappParams
 * says which variables fill its {{1}}, {{2}} … in order (the approved text must match).
 */

type DefaultTemplate = Omit<IMessageTemplate, "version" | "history" | "updatedBy" | "createdAt" | "updatedAt">;

const v = (name: string, sample: string, type: TemplateVariable["type"] = "string", required = true) => ({
  name,
  type,
  required,
  sample,
});
const btn = (action: string, bn: string, en: string) => ({ action, label: { bn, en } });
const wa = (name: string, params: string[]) => ({
  whatsappTemplateName: name,
  whatsappLanguages: { bn: "bn", en: "en" },
  whatsappParams: params,
});

const PATIENT = v("patientName", "Rahim");
const DOCTOR = v("doctorName", "Dr. Farhana Islam");
const DATE = v("date", "2026-10-02", "date");
const TIME = v("time", "10:30", "time");
const SERIAL = v("serial", "7", "number");
const ROOM = v("room", "204", "string", false);
const HOSPITAL = v("hospital", "Testolife Hospital");

export const DEFAULT_TEMPLATES: DefaultTemplate[] = [
  {
    key: "appointment_confirmation",
    description: "Sent right after a booking from any channel",
    category: "confirmation",
    channels: ["whatsapp", "sms"],
    variables: [
      PATIENT,
      DOCTOR,
      DATE,
      TIME,
      SERIAL,
      ROOM,
      v("fee", "800", "money"),
      HOSPITAL,
      v("directions", "https://maps.app.goo.gl/testolife", "url", false),
    ],
    bodies: {
      bn: "{{patientName}}, আপনার সিরিয়াল নিশ্চিত হয়েছে ✅\nডাক্তার: {{doctorName}}\nতারিখ: {{date}}, সময়: {{time}}\nসিরিয়াল: {{serial}} · রুম: {{room}}\nফি: {{fee}}\nঅনুগ্রহ করে ১৫ মিনিট আগে আসবেন। পথ: {{directions}}\n— {{hospital}}",
      en: "{{patientName}}, your appointment is confirmed ✅\nDoctor: {{doctorName}}\nDate: {{date}}, time: {{time}}\nSerial: {{serial}} · Room: {{room}}\nFee: {{fee}}\nPlease arrive 15 minutes early. Directions: {{directions}}\n— {{hospital}}",
    },
    buttons: [
      btn("confirm", "নিশ্চিত করছি", "Confirm"),
      btn("reschedule", "সময় বদলাব", "Reschedule"),
      btn("cancel", "বাতিল করব", "Cancel"),
    ],
    ...wa("tl_appointment_confirmation", ["patientName", "doctorName", "date", "time", "serial"]),
    isActive: true,
  },
  {
    key: "walk_in_welcome",
    description: "Walk-in patients: short welcome with the serial (no reschedule)",
    category: "confirmation",
    channels: ["whatsapp", "sms"],
    variables: [PATIENT, DOCTOR, SERIAL, ROOM, HOSPITAL],
    bodies: {
      bn: "{{hospital}}-এ স্বাগতম, {{patientName}}! আপনার সিরিয়াল {{serial}} ({{doctorName}}, রুম {{room}})। ডাক পড়লে টিভি স্ক্রিনে নম্বর দেখাবে।",
      en: "Welcome to {{hospital}}, {{patientName}}! Your serial is {{serial}} ({{doctorName}}, room {{room}}). Watch the screen for your number.",
    },
    buttons: [],
    ...wa("tl_walk_in_welcome", ["patientName", "serial", "doctorName"]),
    isActive: true,
  },
  {
    key: "reminder_day_before",
    description: "Evening before the appointment",
    category: "reminder",
    channels: ["whatsapp", "sms"],
    variables: [PATIENT, DOCTOR, DATE, TIME, SERIAL, ROOM, HOSPITAL],
    bodies: {
      bn: "মনে করিয়ে দিচ্ছি, {{patientName}}: আগামীকাল {{date}} {{time}}-এ {{doctorName}}-এর সাথে আপনার অ্যাপয়েন্টমেন্ট (সিরিয়াল {{serial}}, রুম {{room}})। ১৫ মিনিট আগে আসবেন।\n— {{hospital}}",
      en: "Reminder, {{patientName}}: tomorrow {{date}} at {{time}} with {{doctorName}} (serial {{serial}}, room {{room}}). Please arrive 15 minutes early.\n— {{hospital}}",
    },
    buttons: [
      btn("confirm", "আসছি", "I'll come"),
      btn("reschedule", "সময় বদলাব", "Reschedule"),
      btn("cancel", "বাতিল করব", "Cancel"),
    ],
    ...wa("tl_reminder_day_before", ["patientName", "date", "time", "doctorName", "serial"]),
    isActive: true,
  },
  {
    key: "reminder_same_day",
    description: "A little before the slot on the day",
    category: "reminder",
    channels: ["whatsapp", "sms"],
    variables: [
      PATIENT,
      DOCTOR,
      TIME,
      SERIAL,
      ROOM,
      v("queueLink", "https://testolife.example/queue", "url", false),
      v("directions", "https://maps.app.goo.gl/testolife", "url", false),
    ],
    bodies: {
      bn: "{{patientName}}, আজ {{time}}-এ {{doctorName}}-এর সাথে আপনার অ্যাপয়েন্টমেন্ট (সিরিয়াল {{serial}}, রুম {{room}})। লাইভ সিরিয়াল: {{queueLink}}\nপথ: {{directions}}",
      en: "{{patientName}}, your appointment with {{doctorName}} is today at {{time}} (serial {{serial}}, room {{room}}). Live queue: {{queueLink}}\nDirections: {{directions}}",
    },
    buttons: [btn("queue", "সিরিয়াল কত দূর?", "Queue status"), btn("cancel", "আসতে পারব না", "Can't come")],
    ...wa("tl_reminder_same_day", ["patientName", "time", "doctorName", "serial"]),
    isActive: true,
  },
  {
    key: "no_show_rebook",
    description: "Polite follow-up after a missed appointment",
    category: "no_show",
    channels: ["whatsapp", "sms"],
    variables: [PATIENT, DOCTOR, HOSPITAL],
    bodies: {
      bn: "{{patientName}}, আজ {{doctorName}}-এর অ্যাপয়েন্টমেন্টে আপনাকে পাইনি। সব ঠিক আছে তো? চাইলে নতুন সময় নিতে পারেন।\n— {{hospital}}",
      en: "{{patientName}}, we missed you today at your appointment with {{doctorName}}. Hope all is well — would you like a new time?\n— {{hospital}}",
    },
    buttons: [
      btn("rebook", "নতুন সময় নেব", "Rebook"),
      btn("not_now", "এখন না", "Not now"),
      btn("stop", "আর মেসেজ নয়", "Don't contact me"),
    ],
    ...wa("tl_no_show_rebook", ["patientName", "doctorName"]),
    isActive: true,
  },
  {
    key: "follow_up_reminder",
    description: "Before the follow-up date the doctor recommended",
    category: "follow_up",
    channels: ["whatsapp", "sms"],
    variables: [PATIENT, DOCTOR, v("followUpDate", "2026-10-05", "date"), HOSPITAL],
    bodies: {
      bn: "{{patientName}}, {{doctorName}} {{followUpDate}} তারিখে ফলো-আপের পরামর্শ দিয়েছিলেন। এখনই সিরিয়াল নেবেন?\n— {{hospital}}",
      en: "{{patientName}}, {{doctorName}} recommended a follow-up on {{followUpDate}}. Book now?\n— {{hospital}}",
    },
    buttons: [btn("book", "সিরিয়াল নেব", "Book"), btn("not_now", "এখন না", "Not now")],
    ...wa("tl_follow_up_reminder", ["patientName", "doctorName", "followUpDate"]),
    isActive: true,
  },
  {
    key: "lab_report_ready",
    description: "A verified lab report can be collected (never the results)",
    category: "report",
    channels: ["whatsapp", "sms"],
    variables: [PATIENT, v("testNames", "CBC, Lipid profile"), v("labHours", "8:00 AM – 8:00 PM"), HOSPITAL],
    bodies: {
      bn: "{{patientName}}, আপনার {{testNames}} রিপোর্ট তৈরি হয়েছে। ল্যাব কাউন্টার থেকে সংগ্রহ করুন ({{labHours}})। নিজে রিপোর্ট বিশ্লেষণ করবেন না — পরের ভিজিটে ডাক্তার দেখে বুঝিয়ে দেবেন।\n— {{hospital}}",
      en: "{{patientName}}, your {{testNames}} report is ready. Please collect it from the lab counter ({{labHours}}). Please do not interpret the results yourself; our doctor will review them at your next visit.\n— {{hospital}}",
    },
    buttons: [btn("book", "ফলো-আপ নেব", "Book follow-up")],
    ...wa("tl_lab_report_ready", ["patientName", "testNames", "labHours"]),
    isActive: true,
  },
  {
    key: "lab_sample_reminder",
    description: "Tests were ordered but no sample was given yet",
    category: "report",
    channels: ["whatsapp", "sms"],
    variables: [PATIENT, v("labHours", "8:00 AM – 8:00 PM"), v("labLocation", "Ground floor, Lab counter"), HOSPITAL],
    bodies: {
      bn: "{{patientName}}, ডাক্তারের দেওয়া পরীক্ষার নমুনা এখনো দেওয়া হয়নি। সুবিধামতো সময়ে ল্যাবে আসুন: {{labLocation}} ({{labHours}})।\n— {{hospital}}",
      en: "{{patientName}}, the tests your doctor ordered are still waiting for your sample. Please visit the lab: {{labLocation}} ({{labHours}}).\n— {{hospital}}",
    },
    buttons: [],
    ...wa("tl_lab_sample_reminder", ["patientName", "labLocation", "labHours"]),
    isActive: true,
  },
  {
    key: "chat_waiting_patient",
    description: "Patient waits for a staff reply in the chat",
    category: "service",
    channels: ["whatsapp"],
    variables: [v("hospitalPhone", "09610-000000")],
    bodies: {
      bn: "আপনার বার্তাটি আমরা পেয়েছি, একজন স্টাফ শীঘ্রই উত্তর দেবেন। দেরির জন্য দুঃখিত। জরুরি হলে ফোন করুন: {{hospitalPhone}}",
      en: "We have your message and a staff member will reply shortly. Sorry for the wait. If it's urgent, please call {{hospitalPhone}}.",
    },
    buttons: [],
    whatsappTemplateName: null,
    whatsappLanguages: { bn: "bn", en: "en" },
    whatsappParams: [],
    isActive: true,
  },
  {
    key: "chat_waiting_staff",
    description: "Internal: a chat is waiting for staff",
    category: "alert",
    channels: ["inapp"],
    variables: [
      v("waitingMinutes", "20", "number"),
      v("channel", "WhatsApp"),
      v("reason", "Patient asked for a person", "string", false),
    ],
    bodies: {
      bn: "একজন রোগী {{waitingMinutes}} মিনিট ধরে উত্তরের অপেক্ষায় ({{channel}})। কারণ: {{reason}}",
      en: "A patient has waited {{waitingMinutes}} min for a reply ({{channel}}). Reason: {{reason}}",
    },
    buttons: [],
    whatsappTemplateName: null,
    whatsappLanguages: { bn: "bn", en: "en" },
    whatsappParams: [],
    isActive: true,
  },
  {
    key: "doctor_absence",
    description: "The doctor will be absent on the booked day",
    category: "service",
    channels: ["whatsapp", "sms"],
    variables: [PATIENT, DOCTOR, DATE, TIME, HOSPITAL],
    bodies: {
      bn: "দুঃখিত {{patientName}}, {{date}} তারিখে {{doctorName}} অনুপস্থিত থাকবেন, তাই {{time}}-এর অ্যাপয়েন্টমেন্টটি হবে না। নতুন সময় বেছে নিন — কোনো বাড়তি খরচ নেই।\n— {{hospital}}",
      en: "Sorry {{patientName}}, {{doctorName}} will be unavailable on {{date}}, so your {{time}} appointment cannot take place. Please choose a new time — no extra charge.\n— {{hospital}}",
    },
    buttons: [btn("reschedule", "নতুন সময় নেব", "Reschedule"), btn("cancel", "বাতিল করব", "Cancel")],
    ...wa("tl_doctor_absence", ["patientName", "doctorName", "date", "time"]),
    isActive: true,
  },
  {
    key: "staff_emergency_alert",
    description: "Internal: emergency conversation in the inbox",
    category: "alert",
    channels: ["inapp", "whatsapp"],
    variables: [v("channel", "WhatsApp"), v("reason", "Emergency keywords detected")],
    bodies: {
      bn: "🚨 জরুরি: ইনবক্সে একটি জরুরি কথোপকথন ({{channel}})। কারণ: {{reason}}। এখনই দেখুন।",
      en: "🚨 EMERGENCY conversation in the inbox ({{channel}}). Reason: {{reason}}. Please respond now.",
    },
    buttons: [],
    ...wa("tl_staff_emergency_alert", ["channel", "reason"]),
    isActive: true,
  },
  {
    key: "staff_failure_alert",
    description: "Internal: many automated sends failed in the last hour",
    category: "alert",
    channels: ["inapp"],
    variables: [v("count", "6", "number"), v("topError", "WhatsApp is not configured", "string", false)],
    bodies: {
      bn: "⚠️ গত এক ঘণ্টায় {{count}}টি স্বয়ংক্রিয় মেসেজ পাঠানো যায়নি। প্রধান কারণ: {{topError}}। Automation → Outbox দেখুন।",
      en: "⚠️ {{count}} automated messages failed in the last hour. Top error: {{topError}}. Check Automation → Outbox.",
    },
    buttons: [],
    whatsappTemplateName: null,
    whatsappLanguages: { bn: "bn", en: "en" },
    whatsappParams: [],
    isActive: true,
  },
  {
    key: "daily_digest",
    description: "Internal: plain end-of-day numbers for management",
    category: "alert",
    channels: ["inapp"],
    variables: [
      v("date", "2026-10-01", "date"),
      v("appointments", "84", "number"),
      v("completed", "70", "number"),
      v("noShows", "6", "number"),
      v("cancelled", "8", "number"),
      v("pendingLab", "12", "number"),
      v("chats", "41", "number"),
      v("chatBookings", "9", "number"),
      v("messagesSent", "120", "number"),
    ],
    bodies: {
      bn: "দৈনিক সারাংশ {{date}}: অ্যাপয়েন্টমেন্ট {{appointments}} (সম্পন্ন {{completed}}, অনুপস্থিত {{noShows}}, বাতিল {{cancelled}}) · অপেক্ষমাণ ল্যাব রিপোর্ট {{pendingLab}} · চ্যাট {{chats}} · চ্যাট/হোয়াটসঅ্যাপে বুকিং {{chatBookings}} · পাঠানো মেসেজ {{messagesSent}}",
      en: "Daily digest {{date}}: appointments {{appointments}} (completed {{completed}}, no-shows {{noShows}}, cancelled {{cancelled}}) · pending lab reports {{pendingLab}} · chats {{chats}} · bookings via chat/WhatsApp {{chatBookings}} · messages sent {{messagesSent}}",
    },
    buttons: [],
    whatsappTemplateName: null,
    whatsappLanguages: { bn: "bn", en: "en" },
    whatsappParams: [],
    isActive: true,
  },
  {
    key: "birthday_greeting",
    description: "Marketing: birthday wishes (opt-in only)",
    category: "promotion",
    channels: ["whatsapp"],
    variables: [PATIENT, HOSPITAL],
    bodies: {
      bn: "শুভ জন্মদিন, {{patientName}}! 🎉 সুস্থ ও আনন্দে থাকুন। — {{hospital}}",
      en: "Happy birthday, {{patientName}}! 🎉 Wishing you good health. — {{hospital}}",
    },
    buttons: [],
    ...wa("tl_birthday_greeting", ["patientName"]),
    isActive: true,
  },
  {
    key: "opt_out_confirmed",
    description: "Reply to STOP / Don't contact me",
    category: "service",
    channels: ["whatsapp"],
    variables: [],
    bodies: {
      bn: "ঠিক আছে, আর কোনো রিমাইন্ডার বা প্রচারমূলক মেসেজ পাঠানো হবে না। জরুরি বিষয় (যেমন আপনার অ্যাপয়েন্টমেন্ট বাতিল হলে) তবুও জানাব। আবার চালু করতে START লিখুন বা রিসেপশনে বলুন।",
      en: "Done — you won't get reminders or promotional messages any more. We will still tell you about essential matters (for example if we must cancel your appointment). Reply START or ask reception to turn them back on.",
    },
    buttons: [],
    whatsappTemplateName: null,
    whatsappLanguages: { bn: "bn", en: "en" },
    whatsappParams: [],
    isActive: true,
  },
];
