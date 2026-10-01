import { env } from "../config/env";
import { logger } from "../utils/logger";
import { removeLegacyUsers, seedDemoUsers } from "./demoUsers";
import { linkDemoDoctor, seedHospitalData } from "./hospitalSeed";
import { seedClinicalHistory } from "./seed-data/clinicalHistory";
import { seedDemoActivity } from "./seed-data/demoActivity";
import { seedKnowledge } from "./seed-data/knowledge";
import { seedAssistantDemo } from "./seed-data/assistantDemo";
import { seedAutomationDemo } from "./seed-data/automationDemo";

// Runs on every server start: reference data the app needs (idempotent).
export const seedReferenceData = async () => {
  await seedHospitalData();
};

// `npm run seed`: reference data + demo accounts + demo patients/appointments (idempotent).
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
  // Fictional patients and 30 days of appointments so dashboards and the TV look alive
  if (env.NODE_ENV !== "production") {
    await seedDemoActivity();
    // Visits, vitals, prescriptions and lab orders for the demo doctor (needs the demo accounts)
    await seedClinicalHistory();
    // Hospital knowledge base for the patient assistant (22 bilingual articles)
    await seedKnowledge();
    // Staff inbox demo: a few assistant conversations (one emergency, one waiting for staff)
    await seedAssistantDemo();
    // Automation demo (simulated): a demo patient with reminders due within minutes, outbox history
    await seedAutomationDemo();
  }
};

export default seedDatabase;
