import { MongoMemoryReplSet } from "mongodb-memory-server";

// Starts ONE throwaway MongoDB for the whole test run; each test file uses its own database in it.
// A single-node REPLICA SET (not a standalone server) because booking uses multi-document
// transactions, which MongoDB only supports on replica sets — exactly like Atlas in production.
export default async function globalSetup() {
  const server = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  (globalThis as { __MONGO_SERVER__?: MongoMemoryReplSet }).__MONGO_SERVER__ = server;
  process.env.TEST_MONGO_URI = server.getUri();
}
