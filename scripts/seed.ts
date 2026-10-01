// Usage: npm run seed
// Creates demo departments/doctors and one demo account per role (password =
// DEMO_PASSWORD from .env). Idempotent — running it twice does not duplicate data.
// Also removes user records left over from the old pre-Phase-2 user module.
import { connectDatabase, disconnectDatabase } from "../src/config/database";
import seedDatabase from "../src/DB";
import { drainEvents } from "../src/events/bus";
import { logger } from "../src/utils/logger";

const run = async () => {
  await connectDatabase();
  await seedDatabase();
  await drainEvents(); // events from the billing backfill / first report finish before the DB closes
  logger.info("Seeding finished");
};

run()
  .catch((err) => {
    logger.error({ err }, "Seeding failed");
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
