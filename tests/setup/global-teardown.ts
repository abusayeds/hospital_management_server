import type { MongoMemoryReplSet } from "mongodb-memory-server";

export default async function globalTeardown() {
  await (globalThis as { __MONGO_SERVER__?: MongoMemoryReplSet }).__MONGO_SERVER__?.stop();
}
