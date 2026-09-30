/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomBytes } from "crypto";
import { getAiProvider, setAiProvider } from "../../src/ai/ai.service";
import type { AiProvider } from "../../src/ai/provider";
import { ChatMessageModel } from "../../src/modules/assistant/chatMessage.model";
import { ConversationModel } from "../../src/modules/assistant/conversation.model";
import { handleInbound } from "../../src/modules/assistant/engine";
import { linkPatients } from "../../src/modules/assistant/otp.service";
import { createPatient } from "../../src/modules/patients/patient.service";
import { Scenario, SCENARIOS, World } from "./scenarios";

export type ScenarioResult = {
  transcript?: string[];
  id: string;
  lang: string;
  title: string;
  passed: boolean;
  failures: string[];
  tools: string[];
  aiCalls: number;
};

let phoneSeq = 0;
const nextPhone = () => {
  phoneSeq += 1;
  return `0171${String(Date.now()).slice(-4)}${String(phoneSeq).padStart(3, "0")}`.slice(0, 11);
};

/** Count model calls without changing the provider's behaviour */
const counting = (inner: AiProvider) => {
  const state = { calls: 0 };
  const provider: AiProvider = {
    name: inner.name,
    generate: (r) => inner.generate(r),
    chat: async (r) => {
      state.calls += 1;
      return inner.chat!(r);
    },
    embed: inner.embed ? (t, o) => inner.embed!(t, o) : undefined,
  };
  return { provider, state };
};

export const runScenario = async (s: Scenario, base: AiProvider): Promise<ScenarioResult> => {
  const { provider, state } = counting(base);
  setAiProvider(provider);
  const phone = nextPhone();
  const e164 = `+88${phone}`;
  const patients = [];
  for (const f of s.family ?? [{ name: `Eval Patient ${s.id}`, gender: "female" as const, age: 30 }])
    patients.push(
      await createPatient({ name: f.name, gender: f.gender, ageYears: f.age, phone }, { allowDuplicate: true }),
    );
  const world: World = { phone: e164, patients, vars: { PHONE: phone } };
  await s.setup?.(world);

  const channelUserId = s.channel === "whatsapp" ? e164.replace("+", "") : randomBytes(16).toString("hex");
  if (s.channel === "web" && s.verified) {
    const conv = await ConversationModel.create({ channel: "web", channelUserId, verifiedPhone: e164, phone: e164 });
    await linkPatients(conv as never);
    await conv.save();
  }

  const failures: string[] = [];
  for (const step of s.steps) {
    const tap = step.tap ? await step.tap(world) : null;
    if (step.tap && !tap) {
      failures.push("a required button was not offered (tap step could not be built)");
      break;
    }
    const result = await handleInbound({
      channel: s.channel,
      channelUserId,
      text: step.text ? Object.entries(world.vars).reduce((t, [k, v]) => t.replace(k, v), step.text) : tap?.label,
      replyId: tap?.replyId,
      unsupported: step.unsupported,
      externalMessageId: s.channel === "whatsapp" ? `wamid.EVAL.${randomBytes(6).toString("hex")}` : undefined,
    });
    world.conv = result.conversation;
  }

  const conv = await ConversationModel.findOne({ channel: s.channel, channelUserId });
  const out = conv ? await ChatMessageModel.find({ conversation: conv._id, direction: "outbound" }).lean<any[]>() : [];
  const tools = [...new Set(out.flatMap((m) => (m.toolCalls ?? []).map((t: any) => t.name)))];
  const everything = out.map((m) => `${m.text}\n${JSON.stringify(m.rich ?? "")}`).join("\n");
  const x = s.expect;

  for (const t of x.tools ?? []) if (!tools.includes(t)) failures.push(`expected tool ${t}`);
  if (x.anyTools && !x.anyTools.some((t) => tools.includes(t)))
    failures.push(`expected one of ${x.anyTools.join(", ")}`);
  for (const t of x.noTools ?? []) if (tools.includes(t)) failures.push(`tool ${t} must not be called`);
  for (const rx of x.forbid ?? []) if (rx.test(everything)) failures.push(`forbidden content ${rx}`);
  for (const rx of x.require ?? []) if (!rx.test(everything)) failures.push(`missing ${rx}`);
  if (x.handover && !["needs_human", "human_active"].includes(conv?.status ?? "")) failures.push("expected a handover");
  if (x.emergency && !conv?.emergency) failures.push("expected the EMERGENCY flag");
  if (x.noAi && state.calls > 0) failures.push(`the model was called ${state.calls} time(s)`);
  if (x.check) {
    const problem = await x.check(world);
    if (problem) failures.push(problem);
  }
  const all = conv ? await ChatMessageModel.find({ conversation: conv._id }).sort({ createdAt: 1 }).lean<any[]>() : [];
  const transcript = all.map((m) => {
    const calls = (m.toolCalls ?? []).map((t: any) => `${t.name}:${t.resultSummary}`).join("; ");
    return `${m.sender}: ${String(m.text).replace(/\n/g, " ").slice(0, 160)}${calls ? `  [${calls}]` : ""}`;
  });
  return {
    transcript,
    id: s.id,
    lang: s.lang,
    title: s.title,
    passed: failures.length === 0,
    failures,
    tools,
    aiCalls: state.calls,
  };
};

export const runAll = async (base: AiProvider, only?: string[]) => {
  const previous = getAiProvider();
  const results: ScenarioResult[] = [];
  for (const s of SCENARIOS.filter((x) => !only?.length || only.includes(x.id))) {
    try {
      results.push(await runScenario(s, base));
    } catch (err) {
      results.push({
        id: s.id,
        lang: s.lang,
        title: s.title,
        passed: false,
        failures: [`crashed: ${(err as Error).message}`],
        tools: [],
        aiCalls: 0,
      });
    }
  }
  setAiProvider(previous ?? undefined);
  return results;
};

export const formatReport = (results: ScenarioResult[], mode: string) => {
  const lines = [
    `\nTestolife assistant evaluation (${mode}) — ${results.filter((r) => r.passed).length}/${results.length} passed\n`,
  ];
  for (const r of results) {
    lines.push(`${r.passed ? "✓" : "✗"} [${r.lang}] ${r.id} — ${r.title}`);
    lines.push(`    tools: ${r.tools.join(", ") || "none"} · model calls: ${r.aiCalls}`);
    for (const f of r.failures) lines.push(`    ✗ ${f}`);
    if (!r.passed || process.env.EVAL_VERBOSE) for (const t of r.transcript ?? []) lines.push(`      · ${t}`);
  }
  return lines.join("\n");
};
