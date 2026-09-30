import { AuditLogModel } from "../../src/modules/audit/auditLog.model";
import { PatientModel } from "../../src/modules/patients/patient.model";
import { namesLookAlike, normalizeName } from "../../src/modules/patients/patient.service";
import { decryptField } from "../../src/utils/crypto";
import { phoneSearchPrefix, toE164Bd } from "../../src/utils/phone";
import { createUser, signIn, useTestDatabase } from "../helpers";

const rahim = { name: "Md. Abdur Rahim", gender: "male", ageYears: 52, phone: "01711-222333", nid: "1990123456789", allergies: ["Penicillin"], chronicConditions: ["Diabetes"] };

describe("phone and name helpers", () => {
  it("normalises every common spelling of a BD mobile to +880", () => {
    for (const input of ["01711222333", "01711-222333", "8801711222333", "+880 1711 222333", "008801711222333"]) {
      expect(toE164Bd(input)).toBe("+8801711222333");
    }
    expect(toE164Bd("0171122233")).toBeNull(); // too short
    expect(toE164Bd("01211222333")).toBeNull(); // 012 is not a mobile operator
  });

  it("turns partial typing into a phone prefix", () => {
    expect(phoneSearchPrefix("0171")).toBe("+880171");
    expect(phoneSearchPrefix("1711")).toBe("+8801711");
    expect(phoneSearchPrefix("rahim")).toBeNull();
  });

  it("treats spelling variants of the same name as look-alikes, different people as different", () => {
    expect(normalizeName("Mohammad  Abdur-Rahim")).toBe("md abdur rahim");
    expect(namesLookAlike(normalizeName("Md. Abdur Rahim"), normalizeName("Mohammad Abdur Rahim"))).toBe(true);
    expect(namesLookAlike(normalizeName("Abdur Rahim"), normalizeName("Abdur Rahym"))).toBe(true);
    expect(namesLookAlike(normalizeName("Abdur Rahim"), normalizeName("Fatema Begum"))).toBe(false);
  });
});

describe("Patients API", () => {
  useTestDatabase();

  const receptionAgent = async () => {
    await createUser({ role: "reception", email: "reception@test.local" });
    return signIn("reception@test.local");
  };

  it("registers a patient with a TL code, +880 phone and an encrypted NID that is never returned", async () => {
    const agent = await receptionAgent();
    const res = await agent.post("/api/v1/patients").send(rahim);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ patientCode: "TL-000001", phone: "+8801711222333", age: 52, dobEstimated: true });
    expect(res.body.data.nidMasked).toMatch(/6789$/);
    expect(JSON.stringify(res.body)).not.toContain("1990123456789");
    expect(JSON.stringify(res.body)).not.toContain("nidEncrypted");

    const stored = await PatientModel.findById(res.body.data.id).select("+nidEncrypted");
    expect(stored!.nidEncrypted).toMatch(/^v1:/);
    expect(decryptField(stored!.nidEncrypted!)).toBe("1990123456789");
  });

  it("warns about a likely duplicate (same phone, similar name) and allows 'create anyway'", async () => {
    const agent = await receptionAgent();
    await agent.post("/api/v1/patients").send(rahim);

    const dup = await agent.post("/api/v1/patients").send({ ...rahim, name: "Mohammad Abdur Rahim", phone: "+8801711222333" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.details.possibleDuplicates[0]).toMatchObject({ patientCode: "TL-000001" });

    // A family member on the same phone with a different name is NOT a duplicate
    const wife = await agent.post("/api/v1/patients").send({ name: "Fatema Begum", gender: "female", ageYears: 47, phone: "01711222333" });
    expect(wife.status).toBe(201);

    const forced = await agent.post("/api/v1/patients").send({ ...rahim, allowDuplicate: true });
    expect(forced.status).toBe(201);
    expect(forced.body.data.patientCode).toBe("TL-000003");
  });

  it("finds everyone sharing a phone, by code and by name", async () => {
    const agent = await receptionAgent();
    await agent.post("/api/v1/patients").send(rahim);
    await agent.post("/api/v1/patients").send({ name: "Fatema Begum", gender: "female", ageYears: 47, phone: "01711222333" });
    await agent.post("/api/v1/patients").send({ name: "Karim Mia", gender: "male", ageYears: 30, phone: "01811000111" });

    expect((await agent.get("/api/v1/patients?q=01711")).body.data).toHaveLength(2);
    expect((await agent.get("/api/v1/patients?q=tl3")).body.data[0].name).toBe("Karim Mia");
    expect((await agent.get("/api/v1/patients?q=fatema")).body.data[0].name).toBe("Fatema Begum");
  });

  it("shapes the response by role: reception gets allergy flags only, doctor gets clinical background", async () => {
    const reception = await receptionAgent();
    const created = await reception.post("/api/v1/patients").send(rahim);
    const id = created.body.data.id;

    const basic = (await reception.get(`/api/v1/patients/${id}`)).body.data;
    expect(basic.allergies).toEqual(["Penicillin"]);
    expect(basic.hasChronicConditions).toBe(true);
    expect(basic.chronicConditions).toBeUndefined();

    await createUser({ role: "doctor", email: "doctor@test.local" });
    const doctor = await signIn("doctor@test.local");
    const full = (await doctor.get(`/api/v1/patients/${id}`)).body.data;
    expect(full.chronicConditions).toEqual(["Diabetes"]);
  });

  it("records who opened a patient profile (VIEW audit)", async () => {
    const agent = await receptionAgent();
    const id = (await agent.post("/api/v1/patients").send(rahim)).body.data.id;
    await agent.get(`/api/v1/patients/${id}`);
    const view = await AuditLogModel.findOne({ action: "VIEW", entityType: "Patient", entityId: id });
    expect(view).toMatchObject({ actorRole: "reception" });
  });

  it("rejects invalid phone numbers and lets only permitted roles register", async () => {
    const agent = await receptionAgent();
    expect((await agent.post("/api/v1/patients").send({ ...rahim, phone: "12345" })).status).toBe(400);

    await createUser({ role: "accounts", email: "accounts@test.local" });
    const accounts = await signIn("accounts@test.local");
    expect((await accounts.get("/api/v1/patients")).status).toBe(403);
    await createUser({ role: "nurse", email: "nurse@test.local" });
    const nurse = await signIn("nurse@test.local");
    expect((await nurse.post("/api/v1/patients").send(rahim)).status).toBe(403);
  });
});
