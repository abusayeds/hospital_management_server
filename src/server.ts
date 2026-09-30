// env must load first: it validates .env and exits with a clear message if invalid
import { env } from "./config/env";
import http from "http";
import app from "./app";
import { connectDatabase, disconnectDatabase } from "./config/database";
import { seedReferenceData } from "./DB";
import { ensureVectorIndex } from "./modules/knowledge/retrieval";
import { isAiConfigured } from "./ai/ai.service";
import { drainEvents } from "./events/bus";
import { closePdfBrowser } from "./documents/pdf";
import { closeSocketIO, initSocketIO } from "./sockets";
import { logger } from "./utils/logger";

const server = http.createServer(app);
let shuttingDown = false;

async function main() {
  await connectDatabase();
  await seedReferenceData();
  // Knowledge search: create the Atlas Vector Search index in the background (text search works without it)
  if (isAiConfigured()) void ensureVectorIndex();

  initSocketIO(server);
  server.listen(env.PORT, () => {
    logger.info(`Testolife API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  });
}

// Stop accepting new requests, let in-flight ones finish, then close the
// database so no write is cut off halfway. Force-exit if it takes too long.
const shutdown = async (signal: string, exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down gracefully...`);

  const forceExit = setTimeout(() => {
    logger.error("Graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  try {
    await closeSocketIO();
    await new Promise<void>((resolve) => (server.listening ? server.close(() => resolve()) : resolve()));
    await drainEvents(); // let pending domain events finish before the DB closes
    await closePdfBrowser();
    await disconnectDatabase();
    logger.info("Shutdown complete");
  } catch (err) {
    logger.error({ err }, "Error during shutdown");
    exitCode = 1;
  }
  process.exit(exitCode);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// A crash means the process may be in an unknown state: log it and exit cleanly
// so the process manager (e.g. PM2) restarts a fresh instance.
process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "Unhandled promise rejection");
  shutdown("unhandledRejection", 1);
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception");
  shutdown("uncaughtException", 1);
});

main().catch((err) => {
  logger.fatal({ err }, "Failed to start server");
  process.exit(1);
});
