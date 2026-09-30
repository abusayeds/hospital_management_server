// Usage: npm run seed:reset
// DELETES all hospital data (departments, doctors, catalogs, settings, patients,
// appointments, queue counters, assistant chats) and seeds it again.
// Users, sessions and the audit log are NOT touched.
// Needed once when upgrading from the Phase-1/2 prototype data format. Never runs in production.
import mongoose from "mongoose";
import { env } from "../src/config/env";
import { connectDatabase, disconnectDatabase } from "../src/config/database";
import seedDatabase from "../src/DB";
import { logger } from "../src/utils/logger";

const HOSPITAL_COLLECTIONS = [
  "departments",
  "doctors",
  "services",
  "labtests",
  "medicines",
  "hospitalsettings",
  "patients",
  "appointments",
  "counters",
  "chatsessions",
  "visits",
  "vitals",
  "laborders",
  "prescriptiontemplates",
  "aisummaries",
  "domainevents",
];

const run = async () => {
  if (env.NODE_ENV === "production") throw new Error("seed:reset is disabled in production");
  await connectDatabase();
  const existing = new Set((await mongoose.connection.db!.listCollections().toArray()).map((c) => c.name));
  for (const name of HOSPITAL_COLLECTIONS) {
    if (existing.has(name)) {
      await mongoose.connection.db!.dropCollection(name);
      logger.info(`Dropped ${name}`);
    }
  }
  // Rebuild indexes (unique / partial indexes) from the current schemas before seeding
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  await seedDatabase();
  logger.info("Hospital data reset and seeded");
};

run()
  .catch((err) => {
    logger.error({ err }, "Reset failed");
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
