import mongoose from "mongoose";
import request from "supertest";
import app from "../src/app";
import { connectDatabase } from "../src/config/database";
import type { Role } from "../src/config/permissions";
import { hashPassword } from "../src/modules/auth/auth.service";
import { UserModel } from "../src/modules/users/user.model";

export const PASSWORD = "Secret123";

/** Call from a describe block: fresh DB before, dropped after. */
export const useTestDatabase = () => {
  beforeAll(async () => {
    await connectDatabase();
  });
  afterEach(async () => {
    await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
};

export const createUser = async (
  overrides: Partial<{
    role: Role;
    email: string;
    password: string;
    isActive: boolean;
    mustChangePassword: boolean;
    name: string;
  }> = {},
) => {
  const role = overrides.role ?? "reception";
  return UserModel.create({
    name: overrides.name ?? `Test ${role}`,
    email: overrides.email ?? `${role}@test.local`,
    role,
    passwordHash: await hashPassword(overrides.password ?? PASSWORD),
    isActive: overrides.isActive ?? true,
    mustChangePassword: overrides.mustChangePassword ?? false,
  });
};

/** A supertest agent keeps cookies between requests, like a browser tab */
export const signIn = async (email: string, password = PASSWORD) => {
  const agent = request.agent(app);
  const res = await agent.post("/api/v1/auth/login").send({ email, password });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
};

export const cookieValue = (res: request.Response, name: string): string | undefined => {
  const raw = res.headers["set-cookie"] as unknown as string[] | undefined;
  const hit = raw?.find((c) => c.startsWith(`${name}=`));
  return hit?.split(";")[0].slice(name.length + 1) || undefined;
};

export { app, request };
