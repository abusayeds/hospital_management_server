import { AuditLogModel } from "../../src/modules/audit/auditLog.model";
import { UserModel } from "../../src/modules/users/user.model";
import { app, cookieValue, createUser, PASSWORD, request, signIn, useTestDatabase } from "../helpers";

const LOGIN = "/api/v1/auth/login";

describe("Authentication", () => {
  useTestDatabase();

  describe("login", () => {
    it("succeeds, sets httpOnly cookies and never returns secrets", async () => {
      await createUser({ role: "doctor", email: "doc@test.local" });
      const res = await request(app).post(LOGIN).send({ email: "DOC@test.local", password: PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.data.user).toMatchObject({ email: "doc@test.local", role: "doctor" });
      expect(res.body.data.user.permissions).toContain("prescription:create");
      const body = JSON.stringify(res.body);
      expect(body).not.toMatch(/passwordHash|token/i);

      const cookies = (res.headers["set-cookie"] as unknown as string[]).join(" | ");
      expect(cookies).toMatch(/tl_access=[^;]+;.*HttpOnly/);
      expect(cookies).toMatch(/tl_refresh=[^;]+;.*Path=\/api\/v1\/auth;.*HttpOnly/);
      expect(cookies).toMatch(/SameSite=Lax/);
    });

    it("rejects a wrong password with a generic message", async () => {
      await createUser({ email: "a@test.local" });
      const res = await request(app).post(LOGIN).send({ email: "a@test.local", password: "Wrong1234" });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
    });

    it("gives an unknown email exactly the same answer as a wrong password", async () => {
      const res = await request(app).post(LOGIN).send({ email: "nobody@test.local", password: "Wrong1234" });
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({ code: "INVALID_CREDENTIALS", message: "Email or password is incorrect." });
    });

    it("locks the account for 15 minutes after 5 failed attempts", async () => {
      await createUser({ email: "lock@test.local" });
      const attempt = (password: string) => request(app).post(LOGIN).send({ email: "lock@test.local", password });

      for (let i = 1; i <= 4; i++) expect((await attempt("Wrong1234")).status).toBe(401);
      const fifth = await attempt("Wrong1234");
      expect(fifth.status).toBe(423);
      expect(fifth.body.error.code).toBe("ACCOUNT_LOCKED");
      expect(fifth.body.error.details.retryAfterSeconds).toBe(15 * 60);

      // Even the correct password is refused while locked
      const correct = await attempt(PASSWORD);
      expect(correct.status).toBe(423);

      const user = await UserModel.findOne({ email: "lock@test.local" });
      expect(user.lockUntil.getTime()).toBeGreaterThan(Date.now() + 14 * 60 * 1000);
      expect(await AuditLogModel.countDocuments({ action: "ACCOUNT_LOCKED" })).toBe(1);
    });

    it("blocks a deactivated user", async () => {
      await createUser({ email: "off@test.local", isActive: false });
      const res = await request(app).post(LOGIN).send({ email: "off@test.local", password: PASSWORD });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("ACCOUNT_DISABLED");
    });

    it("rejects a NoSQL injection attempt", async () => {
      await createUser({ email: "victim@test.local" });
      const res = await request(app)
        .post(LOGIN)
        .send({ email: { $gt: "" }, password: { $gt: "" } });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(cookieValue(res, "tl_access")).toBeUndefined();
    });

    it("writes LOGIN and LOGIN_FAILED audit entries", async () => {
      await createUser({ email: "audit@test.local" });
      await request(app).post(LOGIN).send({ email: "audit@test.local", password: "Wrong1234" });
      await request(app).post(LOGIN).send({ email: "audit@test.local", password: PASSWORD });
      const actions = (await AuditLogModel.find().sort({ createdAt: 1 })).map((a) => a.action);
      expect(actions).toEqual(["LOGIN_FAILED", "LOGIN"]);
    });
  });

  describe("sessions", () => {
    it("/auth/me returns the user and permissions", async () => {
      await createUser({ role: "nurse", email: "n@test.local" });
      const agent = await signIn("n@test.local");
      const res = await agent.get("/api/v1/auth/me");
      expect(res.status).toBe(200);
      expect(res.body.data.user.role).toBe("nurse");
      expect(res.body.data.user.permissions).toContain("vitals:create");
    });

    it("rotates the refresh token, and reuse of an old one signs the user out everywhere", async () => {
      await createUser({ email: "rot@test.local" });
      const login = await request(app).post(LOGIN).send({ email: "rot@test.local", password: PASSWORD });
      const firstRefresh = cookieValue(login, "tl_refresh")!;
      const secondDevice = await signIn("rot@test.local"); // another session of the same user

      const refreshed = await request(app).post("/api/v1/auth/refresh").set("Cookie", `tl_refresh=${firstRefresh}`);
      expect(refreshed.status).toBe(200);
      const newRefresh = cookieValue(refreshed, "tl_refresh")!;
      expect(newRefresh).not.toBe(firstRefresh);

      // An attacker replays the OLD token → theft detected
      const replay = await request(app).post("/api/v1/auth/refresh").set("Cookie", `tl_refresh=${firstRefresh}`);
      expect(replay.status).toBe(401);
      expect(replay.body.error.code).toBe("SESSION_REVOKED");

      // ...and every session of that user is gone, including the new token and the other device
      const withNew = await request(app).post("/api/v1/auth/refresh").set("Cookie", `tl_refresh=${newRefresh}`);
      expect(withNew.status).toBe(401);
      expect((await secondDevice.get("/api/v1/auth/me")).status).toBe(401);
      expect(await AuditLogModel.countDocuments({ action: "TOKEN_REUSE_DETECTED" })).toBe(1);
    });

    it("logout ends the session immediately", async () => {
      await createUser({ email: "out@test.local" });
      const agent = await signIn("out@test.local");
      expect((await agent.get("/api/v1/auth/me")).status).toBe(200);
      expect((await agent.post("/api/v1/auth/logout")).status).toBe(200);
      expect((await agent.get("/api/v1/auth/me")).status).toBe(401);
    });

    it("a deactivated user is kicked out of an existing session", async () => {
      const user = await createUser({ email: "kick@test.local" });
      const agent = await signIn("kick@test.local");
      expect((await agent.get("/api/v1/auth/me")).status).toBe(200);
      await UserModel.updateOne({ _id: user._id }, { $set: { isActive: false } });
      const res = await agent.get("/api/v1/auth/me");
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("ACCOUNT_DISABLED");
    });
  });

  describe("passwords", () => {
    it("forces a password change before anything else, then works", async () => {
      await createUser({ role: "super_admin", email: "new@test.local", mustChangePassword: true });
      const agent = await signIn("new@test.local");

      const blocked = await agent.get("/api/v1/users");
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe("PASSWORD_CHANGE_REQUIRED");
      expect((await agent.get("/api/v1/auth/me")).status).toBe(200); // allowed while pending

      const weak = await agent
        .post("/api/v1/auth/change-password")
        .send({ currentPassword: PASSWORD, newPassword: "short" });
      expect(weak.status).toBe(400);

      const ok = await agent
        .post("/api/v1/auth/change-password")
        .send({ currentPassword: PASSWORD, newPassword: "BetterPass9" });
      expect(ok.status).toBe(200);
      expect(ok.body.data.user.mustChangePassword).toBe(false);
      expect((await agent.get("/api/v1/users")).status).toBe(200);
    });

    it("changing the password signs out the user's other sessions", async () => {
      await createUser({ email: "pw@test.local" });
      const thisDevice = await signIn("pw@test.local");
      const otherDevice = await signIn("pw@test.local");

      const res = await thisDevice
        .post("/api/v1/auth/change-password")
        .send({ currentPassword: PASSWORD, newPassword: "NewSecret42" });
      expect(res.status).toBe(200);
      expect((await thisDevice.get("/api/v1/auth/me")).status).toBe(200);
      expect((await otherDevice.get("/api/v1/auth/me")).status).toBe(401);
      expect(await AuditLogModel.countDocuments({ action: "PASSWORD_CHANGE" })).toBe(1);
    });
  });
});
