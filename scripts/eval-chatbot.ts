// Usage:
//   npm run eval:chatbot            → deterministic mock model (same result every time; used in CI)
//   npm run eval:chatbot -- --real  → the configured AI provider (AI_API_KEY / GEMINI_API_KEY)
//   npm run eval:chatbot -- --only emergency-bn,kb-lipid-bn
// Runs on a throw-away in-memory MongoDB (never your Atlas data), seeds master data + knowledge base,
// plays every scenario through the real conversation engine and prints a pass/fail report.
import { MongoMemoryReplSet } from "mongodb-memory-server";

const args = process.argv.slice(2);
const real = args.includes("--real");
const onlyArg = args.find((a) => a.startsWith("--only"));
const only = onlyArg ? (onlyArg.split("=")[1] ?? args[args.indexOf(onlyArg) + 1] ?? "").split(",").filter(Boolean) : [];

const main = async () => {
  const server = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  // Must be set BEFORE the app modules read their configuration
  process.env.DATABASE_URL = server.getUri();
  process.env.DB_NAME = "testolife_eval";
  process.env.DNS_SERVERS = "";
  process.env.LOG_LEVEL = "error";
  if (!real) {
    process.env.GEMINI_API_KEY = "";
    process.env.AI_API_KEY = "";
  }

  const { connectDatabase, disconnectDatabase } = await import("../src/config/database");
  const { seedHospitalData } = await import("../src/DB/hospitalSeed");
  const { seedKnowledge } = await import("../src/DB/seed-data/knowledge");
  const { getAiProvider } = await import("../src/ai/ai.service");
  const { mockProvider } = await import("./eval/mock-model");
  const { runAll, formatReport } = await import("./eval/runner");
  const mongoose = (await import("mongoose")).default;

  await connectDatabase();
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  await seedHospitalData();
  await seedKnowledge();

  const provider = real ? getAiProvider() : mockProvider();
  if (!provider) throw new Error("No AI provider configured for --real (set AI_API_KEY or GEMINI_API_KEY).");
  const results = await runAll(provider, only);
  console.log(formatReport(results, real ? `real provider: ${provider.name}` : "mock model"));

  await disconnectDatabase();
  await server.stop();
  process.exitCode = results.every((r) => r.passed) ? 0 : 1;
};

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
