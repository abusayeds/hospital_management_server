import { AuditLogModel } from "../../src/modules/audit/auditLog.model";
import { clearSettingsCache } from "../../src/modules/hospital/settings/settings.service";
import { app, createUser, request, signIn, useTestDatabase } from "../helpers";

describe("Master data API", () => {
  useTestDatabase();
  beforeEach(() => clearSettingsCache());

  const admin = async () => {
    await createUser({ role: "super_admin", email: "admin@test.local" });
    return signIn("admin@test.local");
  };
  const session = (dayOfWeek: number, startTime: string, endTime: string) => ({ dayOfWeek, startTime, endTime, slotMinutes: 10, maxPatients: 20 });

  it("creates a department and a doctor (fees in poisha), rejects overlapping sessions, audits changes", async () => {
    const agent = await admin();
    const dep = await agent.post("/api/v1/departments").send({ name: "Medicine", nameBn: "মেডিসিন", icon: "stethoscope" });
    expect(dep.status).toBe(201);

    const body = { name: "Farhana Rahman", department: dep.body.data.id, consultationFee: 70000, followUpFee: 35000, sessions: [session(6, "09:00", "13:00"), session(6, "17:00", "20:00")] };
    const doc = await agent.post("/api/v1/doctors").send(body);
    expect(doc.status).toBe(201);
    expect(doc.body.data).toMatchObject({ displayName: "Dr. Farhana Rahman", consultationFeeText: "৳700" });

    const overlap = await agent.patch(`/api/v1/doctors/${doc.body.data.id}`).send({ sessions: [session(1, "09:00", "12:00"), session(1, "11:30", "14:00")] });
    expect(overlap.status).toBe(400);
    expect(overlap.body.error.message).toMatch(/overlaps/);

    expect(await AuditLogModel.countDocuments({ entityType: { $in: ["Department", "Doctor"] }, action: "CREATE" })).toBe(2);
  });

  it("links a doctor login one-to-one and refuses non-doctor accounts", async () => {
    const agent = await admin();
    const dep = (await agent.post("/api/v1/departments").send({ name: "ENT", nameBn: "নাক কান গলা" })).body.data;
    const mk = (name: string) => agent.post("/api/v1/doctors").send({ name, department: dep.id, consultationFee: 60000, followUpFee: 30000 });
    const a = (await mk("Doctor A")).body.data;
    const b = (await mk("Doctor B")).body.data;
    const docUser = await createUser({ role: "doctor", email: "doc@test.local" });
    const nurse = await createUser({ role: "nurse", email: "nurse@test.local" });

    expect((await agent.put(`/api/v1/doctors/${a.id}/account`).send({ userId: String(docUser._id) })).body.data.account.email).toBe("doc@test.local");
    expect((await agent.put(`/api/v1/doctors/${b.id}/account`).send({ userId: String(docUser._id) })).status).toBe(409);
    expect((await agent.put(`/api/v1/doctors/${b.id}/account`).send({ userId: String(nurse._id) })).status).toBe(400);
  });

  it("catalogs: only master_data:manage may change them; lab test codes are unique", async () => {
    const agent = await admin();
    const test = { name: "Complete Blood Count", code: "cbc", category: "Hematology", price: 40000, sampleType: "Blood", turnaroundHours: 6, parameters: [{ name: "Hb", unit: "g/dL", normalMin: 12, normalMax: 16 }] };
    const created = await agent.post("/api/v1/lab-tests").send(test);
    expect(created.status).toBe(201);
    expect(created.body.data.code).toBe("CBC");
    expect((await agent.post("/api/v1/lab-tests").send(test)).status).toBe(409);

    await createUser({ role: "reception", email: "rec@test.local" });
    const rec = await signIn("rec@test.local");
    expect((await rec.post("/api/v1/doctors").send({})).status).toBe(403);
    expect((await rec.post("/api/v1/services").send({ name: "X", category: "other", price: 1 })).status).toBe(403);
    expect((await rec.get("/api/v1/doctors")).status).toBe(200); // doctor:read
  });

  it("public hospital info needs no login and exposes only public fields", async () => {
    const res = await request(app).get("/api/v1/public/hospital-info");
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBeTruthy();
    expect(Object.keys(res.body.data)).not.toContain("displayNotice");
    expect(Object.keys(res.body.data)).not.toContain("cancellationCutoffMinutes");
  });
});
