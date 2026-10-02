import { env, productionSchema } from "../../src/config/env";
import { AuditLogModel } from "../../src/modules/audit/auditLog.model";
import { OutboxMessageModel } from "../../src/modules/automation/models/outbox.model";
import { IpBlockModel } from "../../src/modules/security/ipBlock.model";
import { resetIpProtection } from "../../src/modules/security/security.service";
import { app, createUser, PASSWORD, request, signIn, useTestDatabase } from "../helpers";

/** Wait for fire-and-forget work (IP block writes, alerts) to land */
const eventually = async (check: () => Promise<boolean>, ms = 3000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condition not met in time");
};

/** Temporarily lower a limit (limiters read env on every request) */
const withEnv = async (patch: Partial<typeof env>, fn: () => Promise<void>) => {
  const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, env[k as keyof typeof env]]));
  Object.assign(env, patch);
  try {
    await fn();
  } finally {
    Object.assign(env, saved);
  }
};

// The test client connects from loopback, which TRUST_PROXY believes: X-Forwarded-For sets req.ip
const from = (ip: string) => ({ "X-Forwarded-For": ip });

describe("Security hardening", () => {
  useTestDatabase();
  afterEach(() => resetIpProtection());

  // ------------------------------------------------------------------ headers, CORS

  it("sends a strict CSP and no-sniff; HSTS only in production", async () => {
    const res = await request(app).get("/api/v1/health");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["strict-transport-security"]).toBeUndefined();
  });

  it("CORS: an unknown origin's preflight is refused; the frontend's is allowed", async () => {
    const evil = await request(app)
      .options("/api/v1/auth/login")
      .set("Origin", "https://evil.example")
      .set("Access-Control-Request-Method", "POST");
    expect(evil.status).toBe(403);
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();

    const ok = await request(app)
      .options("/api/v1/auth/login")
      .set("Origin", "http://localhost:3000")
      .set("Access-Control-Request-Method", "POST");
    expect(ok.status).toBe(204);
    expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });

  // ------------------------------------------------------------------ rate limits

  it("login: 429 after the limit for one IP + email, other staff on the same network unaffected (audited)", async () => {
    await createUser({ role: "reception", email: "rec@test.local" });
    await withEnv({ AUTH_RATE_LIMIT_MAX: 3 }, async () => {
      const tryLogin = (email: string) =>
        request(app).post("/api/v1/auth/login").set(from("203.0.113.10")).send({ email, password: "wrong-pass1" });
      for (let i = 0; i < 3; i++) expect((await tryLogin("rec@test.local")).status).toBe(401);
      const limited = await tryLogin("rec@test.local");
      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe("RATE_LIMITED");
      expect((await tryLogin("someone.else@test.local")).status).toBe(401);
    });
    await eventually(async () =>
      Boolean(await AuditLogModel.exists({ action: "LOGIN_FAILED", "meta.reason": "rate_limited" })),
    );
  });

  it("change password: 429 after the limit per user", async () => {
    await createUser({ role: "reception", email: "rec@test.local" });
    const agent = await signIn("rec@test.local");
    await withEnv({ CHANGE_PASSWORD_RATE_LIMIT_MAX: 2 }, async () => {
      const change = () =>
        agent.post("/api/v1/auth/change-password").send({ currentPassword: "Wrong1234", newPassword: "NewSecret456" });
      expect((await change()).status).not.toBe(429);
      expect((await change()).status).not.toBe(429);
      expect((await change()).status).toBe(429);
    });
  });

  it("per-user write budget: changes beyond the hourly limit get 429 (reads still work)", async () => {
    await createUser({ role: "reception", email: "rec@test.local" });
    const agent = await signIn("rec@test.local");
    await withEnv({ USER_WRITE_LIMIT_PER_HOUR: 2 }, async () => {
      expect((await agent.post("/api/v1/patients").send({})).status).toBe(400);
      expect((await agent.post("/api/v1/patients").send({})).status).toBe(400);
      expect((await agent.post("/api/v1/patients").send({})).status).toBe(429);
      expect((await agent.get("/api/v1/auth/me")).status).toBe(200);
    });
  });

  // ------------------------------------------------------------------ IP protection

  it("IP circuit breaker: too many requests from one IP blocks it, stores the block and alerts admins", async () => {
    await withEnv({ IP_BLOCK_THRESHOLD_PER_HOUR: 3 }, async () => {
      for (let i = 0; i < 3; i++)
        expect((await request(app).get("/api/v1/nope").set(from("198.51.100.20"))).status).toBe(404);
      const blocked = await request(app).get("/api/v1/nope").set(from("198.51.100.20"));
      expect(blocked.status).toBe(429);
      expect(blocked.headers["retry-after"]).toBeDefined();
      // A different network is not affected
      expect((await request(app).get("/api/v1/nope").set(from("198.51.100.21"))).status).toBe(404);
    });
    await eventually(async () => Boolean(await OutboxMessageModel.exists({ toRef: "perm:settings:manage" })));
    expect(await IpBlockModel.findOne({ ip: "198.51.100.20" }).lean()).toMatchObject({ reason: "request_flood" });
    expect(await AuditLogModel.countDocuments({ action: "IP_BLOCKED", entityId: "198.51.100.20" })).toBe(1);
  });

  it("failed sign-ins: an IP spraying many emails is blocked; an admin can lift the block (audited)", async () => {
    await createUser({ role: "super_admin", email: "admin@test.local" });
    await withEnv({ FAILED_LOGIN_BLOCK_THRESHOLD: 4 }, async () => {
      for (let i = 0; i < 4; i++)
        await request(app)
          .post("/api/v1/auth/login")
          .set(from("192.0.2.33"))
          .send({ email: `guess${i}@test.local`, password: "Guess1234" });
      await eventually(async () => Boolean(await IpBlockModel.exists({ ip: "192.0.2.33", reason: "failed_logins" })));
      const refused = await request(app)
        .post("/api/v1/auth/login")
        .set(from("192.0.2.33"))
        .send({ email: "admin@test.local", password: PASSWORD });
      expect(refused.status).toBe(429);
    });
    // The block is stored first; the audit row and the admin alert follow it
    await eventually(async () => Boolean(await OutboxMessageModel.exists({ toRef: "perm:settings:manage" })));
    const alert = await OutboxMessageModel.findOne({ toRef: "perm:settings:manage" }).lean();
    expect(alert?.renderedText).toContain("192.0.2.33");

    const admin = await signIn("admin@test.local");
    const overview = await admin.get("/api/v1/security/overview");
    expect(overview.status).toBe(200);
    expect(overview.body.data.blocks[0]).toMatchObject({ ip: "192.0.2.33", active: true });
    expect(overview.body.data.last24h.failedLogins).toBeGreaterThanOrEqual(4);

    expect((await admin.delete("/api/v1/security/blocks/192.0.2.33")).body.data).toMatchObject({ lifted: true });
    expect(
      await AuditLogModel.exists({ action: "UPDATE", entityType: "IpAddress", "meta.event": "unblock" }),
    ).toBeTruthy();
    expect(
      (
        await request(app)
          .post("/api/v1/auth/login")
          .set(from("192.0.2.33"))
          .send({ email: "admin@test.local", password: PASSWORD })
      ).status,
    ).toBe(200);
  });

  it("the security page needs audit:read and lifting a block needs settings:manage", async () => {
    await createUser({ role: "management", email: "mgmt@test.local" });
    await createUser({ role: "reception", email: "rec@test.local" });
    expect((await (await signIn("rec@test.local")).get("/api/v1/security/overview")).status).toBe(403);
    expect((await (await signIn("mgmt@test.local")).delete("/api/v1/security/blocks/192.0.2.1")).status).toBe(403);
  });

  // ------------------------------------------------------------------ data protection

  it("the NID is never written to the audit log", async () => {
    await createUser({ role: "reception", email: "rec@test.local" });
    const agent = await signIn("rec@test.local");
    const res = await agent
      .post("/api/v1/patients")
      .send({ name: "Md. Abdur Rahim", gender: "male", ageYears: 52, phone: "01711-222333", nid: "1990123456789" });
    expect(res.status).toBe(201);
    const logs = await AuditLogModel.find({ entityType: "Patient" }).lean();
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toContain("1990123456789");
  });

  // ------------------------------------------------------------------ production configuration

  describe("production configuration", () => {
    const base = {
      ...process.env,
      NODE_ENV: "production",
      CLIENT_URL: "https://app.testolife.example",
      DEMO_PASSWORD: "",
      AI_PROVIDER: "gemini",
      AI_API_KEY: "test-key",
      TLS_TERMINATED_BY_PROXY: "true",
      TLS_CERT_PATH: "",
      TLS_KEY_PATH: "",
    };
    const problems = (overrides: Record<string, string>) => {
      const r = productionSchema.safeParse({ ...base, ...overrides });
      return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
    };

    it("accepts a correct production setup", () => {
      expect(problems({})).toEqual([]);
      expect(
        problems({
          TLS_TERMINATED_BY_PROXY: "false",
          TLS_CERT_PATH: "/etc/ssl/cert.pem",
          TLS_KEY_PATH: "/etc/ssl/key.pem",
        }),
      ).toEqual([]);
    });
    it("refuses to start without HTTPS, without an AI key, with http origins or a demo password", () => {
      expect(problems({ TLS_TERMINATED_BY_PROXY: "false" })).toContain("TLS_CERT_PATH");
      expect(problems({ AI_API_KEY: "", GEMINI_API_KEY: "" })).toContain("AI_API_KEY");
      expect(problems({ AI_API_KEY: "", GEMINI_API_KEY: "", AI_PROVIDER: "none" })).toEqual([]);
      expect(problems({ CLIENT_URL: "http://app.testolife.example" })).toContain("CLIENT_URL");
      expect(problems({ DEMO_PASSWORD: "Demo12345" })).toContain("DEMO_PASSWORD");
    });
  });
});
