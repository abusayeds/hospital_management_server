/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AiChatRequest, AiChatResponse, AiProvider } from "../../src/ai/provider";
import { addDays, todayInDhaka } from "../../src/utils/date";

/**
 * DETERMINISTIC MOCK MODEL for the evaluation in CI.
 * It routes the patient's words to tools with simple keyword rules — like a very literal model —
 * so every scenario exercises the REAL tools, authorisation, confirmation, safety layer and
 * channel code. It cannot judge language quality; run the evaluation with the real provider for that.
 */

const lastUserText = (req: AiChatRequest) => {
  for (let i = req.turns.length - 1; i >= 0; i--) {
    const t = req.turns[i];
    if (t.role === "user") return t.text;
  }
  return "";
};

const firstPatientRef = (system: string) => /\b(P\d+)\s*\(/.exec(system)?.[1] ?? null;
const hasPhone = (system: string) => /(WhatsApp number|Phone given) \(ends with/.test(system);
const REGISTER = /(?:name|patient)\s*:?\s+([A-Za-z ]+?),\s*(male|female),\s*(\d{1,3})/i;

const call = (name: string, args: Record<string, unknown> = {}): Partial<AiChatResponse> => ({
  toolCalls: [{ id: `${name}-${Math.random().toString(36).slice(2, 7)}`, name, args }],
});
const say = (text: string): Partial<AiChatResponse> => ({ text, toolCalls: [] });

const STOP = new Set([
  "what",
  "when",
  "where",
  "have",
  "your",
  "with",
  "this",
  "that",
  "from",
  "there",
  "patients",
  "patient",
  "hospital",
  "please",
  "করতে",
  "হবে",
  "আছে",
]);

// Split on spaces and punctuation only (Bangla vowel signs are not "letters" in \p{L})
const wordsOf = (query: string) =>
  query
    .toLowerCase()
    .split(/[\s,.?!।:;()"'/]+/)
    .filter((w) => w.length >= 4 && !STOP.has(w));

/** A literal model answers from the passage sharing the most meaningful words with the question */
const bestPassage = (query: string, passages: any[]) => {
  const words = wordsOf(query);
  const scored = passages.map((p) => {
    const text = `${p.source} ${p.text}`.toLowerCase();
    return { p, hits: words.filter((w) => text.includes(w)).length };
  });
  scored.sort((a, b) => b.hits - a.hits);
  return scored[0]?.hits ? scored[0].p : null;
};

/** After a tool ran: a short answer built from its result (what a model would say) */
const answerFromTool = (name: string, result: any, query = ""): Partial<AiChatResponse> => {
  const best = Array.isArray(result) ? bestPassage(query, result) : null;
  if (result?.error === "no_phone")
    return say("আপনার মোবাইল নম্বরটি দিন। · Please share your mobile number.");
  if (result?.error) return say(`দুঃখিত: ${result.error}`);
  switch (name) {
    case "search_knowledge_base":
      return result?.found === 0 || !best
        ? say(
            "দুঃখিত, এই তথ্যটি আমার জানা নেই। একজন স্টাফের সাথে কথা বলতে চান? · Sorry, I don't know that. Shall I connect you to a staff member?",
          )
        : say(`${best.source}: ${String(best.text).slice(0, 400)}`);
    case "get_lab_report_status":
      return say(
        Array.isArray(result)
          ? `আপনার রিপোর্টের অবস্থা: ${result.map((r: any) => r.status).join(", ")}`
          : "কোনো রিপোর্ট পাওয়া যায়নি।",
      );
    case "get_hospital_info":
      return say(`${result.name}, ${result.address}. Emergency: ${result.emergencyPhone}`);
    case "get_queue_status":
      return say(
        result?.found === false ? "আজ কোনো অ্যাপয়েন্টমেন্ট নেই।" : `আপনার আগে ${result.peopleAhead} জন আছেন।`,
      );
    case "request_human":
      return say("একজন স্টাফকে জানানো হয়েছে।");
    default:
      return say("এই যে তথ্য · Here you go.");
  }
};

export const mockModel = (req: AiChatRequest): Partial<AiChatResponse> => {
  const last = req.turns[req.turns.length - 1];
  if (last?.role === "tool") {
    const r = last.results[0];
    // Two-step intents: appointments listed → now cancel / reschedule the first one
    const intent = lastUserText(req).toLowerCase();
    if (r.name === "get_my_appointments" && Array.isArray(r.result) && r.result.length) {
      if (/cancel|বাতিল/.test(intent)) return call("cancel_appointment", { appointmentRef: r.result[0].ref });
      if (/reschedule|বদল|পিছিয়ে/.test(intent))
        return call("reschedule_appointment", {
          appointmentRef: r.result[0].ref,
          newDate: /\d{4}-\d{2}-\d{2}/.exec(intent)?.[0] ?? addDays(todayInDhaka(), 2),
        });
    }
    // Number saved and the same message named the patient → register them next
    const reg = REGISTER.exec(lastUserText(req));
    if (r.name === "set_phone" && reg)
      return call("register_patient", { name: reg[1].trim(), gender: reg[2].toLowerCase(), age: Number(reg[3]) });
    return answerFromTool(r.name, r.result, intent);
  }

  const text = lastUserText(req);
  const t = text.toLowerCase();
  const tap = /^Book doctorId (\w+) on (\S+) at (\S+)\./.exec(text);
  if (tap) {
    const ref = firstPatientRef(req.system);
    if (!hasPhone(req.system) || !ref)
      return say("প্রথমে আপনার মোবাইল নম্বর দিন। · Please share your mobile number first.");
    return call("book_appointment", { patientRef: ref, doctorId: tap[1], date: tap[2], slotTime: tap[3] });
  }
  const chooseDoctor = /doctorId (\w+)\. Show free slots/.exec(text);
  if (chooseDoctor) return call("get_available_slots", { doctorId: chooseDoctor[1], date: addDays(todayInDhaka(), 1) });

  const phone = /(01[3-9]\d{8})/.exec(text.replace(/[\s-]/g, ""));
  if (phone && !hasPhone(req.system)) return call("set_phone", { phone: phone[1] });

  // Medicines / doses: refuse, suggest a doctor (checked before "medicine doctor")
  if (/(ওষুধ|osudh|oshudh|khabo|খাব|dose|mg\b|কত বার|koto bar)/i.test(text) && !/doctor|ডাক্তার/i.test(text))
    return say("দুঃখিত, ওষুধ নিয়ে পরামর্শ দিতে পারি না — Medicine বিভাগের ডাক্তার দেখাতে পারেন। সিরিয়াল নিয়ে দেব?");
  if (/(human|person|মানুষ|staff|স্টাফ)/i.test(t))
    return call("request_human", { reason: "patient asked for a person" });
  if (/(mother|father|family|মা|বাবা|মায়ের|babar|mayer)/i.test(t) && /(book|serial|সিরিয়াল)/i.test(t))
    return call("list_my_patients");
  const reg = REGISTER.exec(text);
  if (reg) return call("register_patient", { name: reg[1].trim(), gender: reg[2].toLowerCase(), age: Number(reg[3]) });
  if (/(ahead|queue|আগে কতজন|koto jon)/i.test(t)) return call("get_queue_status");
  if (/(report|রিপোর্ট|result|hba1c)/i.test(t)) return call("get_lab_report_status");
  if (/(cancel|বাতিল|reschedule|বদল|appointments?|অ্যাপয়েন্টমেন্ট)/i.test(t)) return call("get_my_appointments");
  const dept = /(cardio|কার্ডিও)/i.test(t)
    ? "Cardiology"
    : /(শিশু|child|pediatric|shishu)/i.test(t)
      ? "Pediatrics"
      : /(medicine|মেডিসিন)/i.test(t)
        ? "Medicine"
        : null;
  if (dept || /(doctor|ডাক্তার|serial|সিরিয়াল)/i.test(t))
    return call("search_doctors", dept ? { department: dept } : {});
  if (/(address|ঠিকানা|kothay|কোথায়|location)/i.test(t)) return call("get_hospital_info");
  if (/(usg|ultrasound|আল্ট্রা)/i.test(t))
    return call("search_knowledge_base", { query: "ultrasound whole abdomen preparation" });
  return call("search_knowledge_base", { query: text });
};

export const mockProvider = (): AiProvider & { calls: number } => {
  const p = {
    name: "mock",
    calls: 0,
    generate: async () => ({ text: '{"summary":"—"}', model: "mock" }),
    chat: async (req: AiChatRequest): Promise<AiChatResponse> => {
      p.calls += 1;
      return { text: "", toolCalls: [], model: "mock-intent-router", ...mockModel(req) };
    },
  };
  return p;
};
