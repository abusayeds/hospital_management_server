import dns from "dns";
import mongoose from "mongoose";
import { env } from "./env";
import { logger } from "../utils/logger";

const STATES: Record<number, string> = {
  0: "disconnected",
  1: "connected",
  2: "connecting",
  3: "disconnecting",
};

export const getDatabaseState = (): string => STATES[mongoose.connection.readyState] ?? "unknown";

export const connectDatabase = async (): Promise<void> => {
  mongoose.set("strictQuery", true);
  if (env.DNS_SERVERS.length) dns.setServers(env.DNS_SERVERS);

  mongoose.connection.on("connected", () => logger.info(`MongoDB connected (db: ${mongoose.connection.name})`));
  mongoose.connection.on("disconnected", () => logger.warn("MongoDB disconnected"));
  mongoose.connection.on("reconnected", () => logger.info("MongoDB reconnected"));
  mongoose.connection.on("error", (err) => logger.error({ err }, "MongoDB connection error"));

  await mongoose.connect(env.DATABASE_URL, {
    dbName: env.DB_NAME,
    serverSelectionTimeoutMS: 10_000,
  });
};

export const disconnectDatabase = async (): Promise<void> => {
  await mongoose.connection.close();
  logger.info("MongoDB connection closed");
};
