import { env } from "../config/env";
import { logger } from "../utils/logger";
import { removeLegacyUsers, seedDemoUsers } from "./demoUsers";
import { linkDemoDoctor, seedHospitalData } from "./hospitalSeed";
import { seedKnowledge } from "./seed-data/knowledge";
import { seedPrescriptionTemplates } from "./seed-data/prescriptionTemplates";

// Runs on every server start: reference data the app needs (idempotent).
export const seedReferenceData = async () => {
  await seedHospitalData();
};

// `npm run seed`: reference data + demo staff accounts + knowledge base (idempotent, no patients).
const seedDatabase = async () => {
  await seedReferenceData();
  await removeLegacyUsers();
  if (env.NODE_ENV === "production") {
    logger.warn("Demo accounts are never created in production");
  } else if (!env.DEMO_PASSWORD) {
    logger.warn("DEMO_PASSWORD is not set in .env — skipping demo accounts");
  } else {
    await seedDemoUsers(env.DEMO_PASSWORD);
    await linkDemoDoctor();
  }
  // No fictional patients: patients are registered by reception with REAL phone numbers, so automated
  // WhatsApp messages only ever reach people who were registered on purpose.
  if (env.NODE_ENV !== "production") {
    // The demo doctor's prescription templates
    await seedPrescriptionTemplates();
    // Hospital knowledge base for the patient assistant (22 bilingual articles)
    await seedKnowledge();
  }
};

export default seedDatabase;
