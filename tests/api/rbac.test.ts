import { Role } from "../../src/config/permissions";
import { AuditLogModel } from "../../src/modules/audit/auditLog.model";
import { app, createUser, PASSWORD, request, signIn, useTestDatabase } from "../helpers";

// One endpoint each role must NOT be able to use
const FORBIDDEN: [Role, "get" | "post", string][] = [
  ["management", "get", "/api/v1/users"],
  ["reception", "get", "/api/v1/audit-logs"],
  ["doctor", "get", "/api/v1/users"],
  ["nurse", "get", "/api/v1/users"],
  ["lab_technician", "get", "/api/v1/appointments?date=2026-01-01"],
  ["pharmacist", "get", "/api/v1/chat/sessions"],
  ["accounts", "get", "/api/v1/dashboard/stats"],
  ["patient", "get", "/api/v1/appointments?date=2026-01-01"],
  ["super_admin", "get", "/api/v1/chat/sessions"],
];

describe("Role-based access control", () => {
  useTestDatabase();

  it.each(FORBIDDEN)("%s gets 403 on %s %s and it is audited", async (role, method, path) => {
    await createUser({ role, email: `${role}@test.local` });
    const agent = await signIn(`${role}@test.local`);

    const res = await agent[method](path);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");

    const denied = await AuditLogModel.findOne({ action: "PERMISSION_DENIED" });
    expect(denied).toMatchObject({ actorRole: role, entityType: "Route" });
    expect(denied!.meta).toMatchObject({ method: method.toUpperCase() });
  });

  it("nurse is forbidden but doctor and reception may read appointments", async () => {
    for (const role of ["doctor", "reception"] as const) {
      await createUser({ role, email: `${role}@test.local` });
      const agent = await signIn(`${role}@test.local`);
      expect((await agent.get("/api/v1/appointments?date=2026-01-01")).status).toBe(200);
    }
  });

  describe("user management (super_admin)", () => {
    const setup = async () => {
      const admin = await createUser({ role: "super_admin", email: "admin@test.local" });
      return { admin, agent: await signIn("admin@test.local") };
    };

    it("creates a user with a temporary password that must be changed", async () => {
      const { agent } = await setup();
      const res = await agent
        .post("/api/v1/users")
        .send({ name: "Rina Das", email: "rina@test.local", role: "nurse", phone: "01711111111" });
      expect(res.status).toBe(201);
      expect(res.body.data.user).toMatchObject({ email: "rina@test.local", role: "nurse", mustChangePassword: true });
      expect(res.body.data.temporaryPassword).toMatch(/^Tl-/);
      expect(JSON.stringify(res.body.data.user)).not.toMatch(/passwordHash/);

      const login = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "rina@test.local", password: res.body.data.temporaryPassword });
      expect(login.status).toBe(200);
      expect(login.body.data.user.mustChangePassword).toBe(true);

      const audit = await AuditLogModel.findOne({ action: "CREATE", entityType: "User" });
      expect(audit!.after).toMatchObject({ email: "rina@test.local", role: "nurse" });
      expect(JSON.stringify(audit!.after)).not.toMatch(/password/i);
    });

    it("validates input with friendly messages", async () => {
      const { agent } = await setup();
      const res = await agent.post("/api/v1/users").send({ name: "X", email: "not-an-email", role: "king" });
      expect(res.status).toBe(400);
      const paths = res.body.error.details.map((d: { path: string }) => d.path);
      expect(paths).toEqual(expect.arrayContaining(["body.name", "body.email", "body.role"]));
    });

    it("lists users with search, role filter and pagination", async () => {
      const { agent } = await setup();
      await createUser({ role: "doctor", email: "d1@test.local", name: "Dr. Alpha" });
      await createUser({ role: "doctor", email: "d2@test.local", name: "Dr. Beta" });
      await createUser({ role: "nurse", email: "n1@test.local", name: "Nurse Gamma" });

      const res = await agent.get("/api/v1/users?role=doctor&limit=1&page=2");
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.pagination).toMatchObject({ page: 2, limit: 1, total: 2, totalPages: 2 });

      const search = await agent.get("/api/v1/users?search=gamma");
      expect(search.body.data.map((u: { email: string }) => u.email)).toEqual(["n1@test.local"]);
    });

    it("records a role change with before and after", async () => {
      const { agent } = await setup();
      const nurse = await createUser({ role: "nurse", email: "n@test.local" });
      const res = await agent.patch(`/api/v1/users/${nurse._id}`).send({ role: "reception" });
      expect(res.status).toBe(200);
      const audit = await AuditLogModel.findOne({ action: "ROLE_CHANGE" });
      expect(audit!.before).toMatchObject({ role: "nurse" });
      expect(audit!.after).toMatchObject({ role: "reception" });
    });

    it("deactivating a user kicks them out; activating lets them back in", async () => {
      const { agent } = await setup();
      const staff = await createUser({ role: "reception", email: "r@test.local" });
      const staffAgent = await signIn("r@test.local");

      expect((await agent.patch(`/api/v1/users/${staff._id}/deactivate`)).status).toBe(200);
      expect((await staffAgent.get("/api/v1/auth/me")).status).toBe(401);
      expect(
        (await request(app).post("/api/v1/auth/login").send({ email: "r@test.local", password: PASSWORD })).status,
      ).toBe(403);

      expect((await agent.patch(`/api/v1/users/${staff._id}/activate`)).status).toBe(200);
      expect(
        (await request(app).post("/api/v1/auth/login").send({ email: "r@test.local", password: PASSWORD })).status,
      ).toBe(200);
    });

    it("cannot deactivate themselves or remove the last super_admin", async () => {
      const { admin, agent } = await setup();
      const self = await agent.patch(`/api/v1/users/${admin._id}/deactivate`);
      expect(self.status).toBe(409);

      const selfRole = await agent.patch(`/api/v1/users/${admin._id}`).send({ role: "management" });
      expect(selfRole.status).toBe(409);
    });

    it("reset password returns a one-time temporary password and ends the user's sessions", async () => {
      const { agent } = await setup();
      const staff = await createUser({ role: "accounts", email: "acc@test.local" });
      const staffAgent = await signIn("acc@test.local");

      const res = await agent.post(`/api/v1/users/${staff._id}/reset-password`);
      expect(res.status).toBe(200);
      const temp = res.body.data.temporaryPassword;
      expect((await staffAgent.get("/api/v1/auth/me")).status).toBe(401);
      expect(
        (await request(app).post("/api/v1/auth/login").send({ email: "acc@test.local", password: PASSWORD })).status,
      ).toBe(401);
      expect(
        (await request(app).post("/api/v1/auth/login").send({ email: "acc@test.local", password: temp })).status,
      ).toBe(200);
    });
  });

  describe("audit logs API", () => {
    it("super_admin can filter audit logs; entries cannot be modified", async () => {
      await createUser({ role: "super_admin", email: "admin@test.local" });
      const agent = await signIn("admin@test.local");
      await request(app).post("/api/v1/auth/login").send({ email: "admin@test.local", password: "Wrong1234" });

      const res = await agent.get("/api/v1/audit-logs?action=LOGIN_FAILED");
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].action).toBe("LOGIN_FAILED");

      await expect(AuditLogModel.updateMany({}, { $set: { action: "LOGIN" } })).rejects.toThrow(/append-only/);
      await expect(AuditLogModel.deleteMany({})).rejects.toThrow(/append-only/);
    });
  });
});
