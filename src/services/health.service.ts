import mongoose from "mongoose";
import { env } from "../config/env";
import { getDatabaseState } from "../config/database";

export type THealthReport = {
  status: "ok" | "degraded";
  uptimeSeconds: number;
  environment: string;
  timestamp: string;
  database: { state: string; latencyMs: number | null };
};

// A live ping (not just readyState) proves the database actually answers.
const pingDatabase = async (): Promise<number | null> => {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) return null;
  const started = Date.now();
  try {
    await mongoose.connection.db.admin().ping();
    return Date.now() - started;
  } catch {
    return null;
  }
};

const getHealth = async (): Promise<THealthReport> => {
  const latencyMs = await pingDatabase();
  return {
    status: latencyMs === null ? "degraded" : "ok",
    uptimeSeconds: Math.round(process.uptime()),
    environment: env.NODE_ENV,
    timestamp: new Date().toISOString(),
    database: { state: getDatabaseState(), latencyMs },
  };
};

export const healthService = { getHealth };
