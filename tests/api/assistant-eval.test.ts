import mongoose from "mongoose";
import { seedHospitalData } from "../../src/DB/hospitalSeed";
import { seedKnowledge } from "../../src/DB/seed-data/knowledge";
import { mockProvider } from "../../scripts/eval/mock-model";
import { formatReport, runAll } from "../../scripts/eval/runner";
import { SCENARIOS } from "../../scripts/eval/scenarios";
import { useTestDatabase } from "../helpers";

/**
 * The chatbot evaluation (npm run eval:chatbot) in CI: every scenario with the deterministic mock
 * model, through the real engine, tools, safety layer and channels.
 */
describe("Assistant evaluation scenarios (mock model)", () => {
  useTestDatabase();

  it(`all ${SCENARIOS.length} scenarios pass (Bangla, English, Banglish)`, async () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(25);
    expect(new Set(SCENARIOS.map((s) => s.lang))).toEqual(new Set(["bn", "en", "banglish"]));
    await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
    await seedHospitalData();
    await seedKnowledge();
    const results = await runAll(mockProvider());
    const failed = results.filter((r) => !r.passed);
    // eslint-disable-next-line no-console -- show which scenarios failed and why
    if (failed.length) console.log(formatReport(failed, "mock model — failures"));
    expect(failed.map((r) => r.id)).toEqual([]);
  }, 180_000);
});
