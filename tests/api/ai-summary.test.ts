import { aiSettings, setAiProvider } from "../../src/ai/ai.service";
import { assertDeidentified, scrubText } from "../../src/ai/deidentify";
import type { AiProvider, AiRequest } from "../../src/ai/provider";
import { AiUsageModel } from "../../src/ai/usage.model";
import { drainEvents } from "../../src/events/bus";
import { AuditLogModel } from "../../src/modules/audit/auditLog.model";
import { PatientModel } from "../../src/modules/patients/patient.model";
import { createAppointment, createClinic, createPatients } from "../fixtures";
import { createUser, signIn, useTestDatabase } from "../helpers";

const VALID = {
  summary: "Adult with hypertension, BP above target at the last visit.",
  activeProblems: ["Hypertension"],
  currentMedications: ["Amlodipine 5 mg 0+0+1"],
  allergies: ["Penicillin"],
  abnormalFindings: ["BP 150/95"],
  trends: [],
  pointsToReview: ["BP above 140/90 at the last visit"],
};

/** A fake provider: records what it was sent and answers with the given texts in turn */
const fakeProvider = (answers: (string | (() => Promise<never>))[]) => {
  const requests: AiRequest[] = [];
  const provider: AiProvider = {
    name: "fake",
    async generate(req) {
      requests.push(req);
      const next = answers[Math.min(requests.length - 1, answers.length - 1)];
      if (typeof next === "function") return next();
      return { text: next, model: "fake-model" };
    },
  };
  return { provider, requests };
};

describe("De-identification helpers", () => {
  it("scrubs names, phones, patient codes and NID numbers from free text", () => {
    const text = "Rahima Akter's husband (01711-223344) says TL-000045 lost NID 1234567890123.";
    const out = scrubText(text, ["Rahima Akter", "+8801711223344", "TL-000045"]);
    expect(out).not.toMatch(/Rahima|Akter|01711|TL-000045|1234567890123/);
    expect(() => assertDeidentified(out, ["Rahima Akter"])).not.toThrow();
    expect(() => assertDeidentified("history of Rahima", ["Rahima Akter"])).toThrow();
  });
});

describe("AI visit summary", () => {
  useTestDatabase();
  afterEach(() => {
    setAiProvider(undefined);
    aiSettings.timeoutMs = 20000;
  });

  const setup = async () => {
    const doctorUser = await createUser({ role: "doctor", email: "doc@test.local" });
    const { doctor } = await createClinic({ userId: doctorUser._id });
    const [patient] = await createPatients(1);
    await PatientModel.updateOne(
      { _id: patient._id },
      {
        $set: {
          name: "Rahima Akter",
          phone: "+8801711223344",
          address: "House 12, Road 5, Keraniganj",
          allergies: ["Penicillin"],
          chronicConditions: ["Hypertension"],
        },
      },
    );
    const fresh = (await PatientModel.findById(patient._id))!;
    const doc = await signIn("doc@test.local");
    const closeVisit = async (serialNo: number) => {
      const appt = await createAppointment({ patient, doctor, slotTime: `09:${serialNo}0`, serialNo });
      const visitId = (await doc.post(`/api/v1/appointments/${appt._id}/visit`)).body.data.id;
      await doc.patch(`/api/v1/visits/${visitId}`).send({
        historyOfPresentIllness: "Rahima's husband called from 01711223344, headache for 2 days",
        provisionalDiagnosis: "Hypertension",
        prescription: [{ brandName: "Amdocal", genericName: "Amlodipine", strength: "5 mg", dosePattern: "0+0+1" }],
      });
      await doc.post(`/api/v1/visits/${visitId}/close`);
      await drainEvents();
    };
    await closeVisit(1);
    return { doc, doctor, patient: fresh, closeVisit };
  };

  it("sends only de-identified clinical data and returns a labelled draft (audited, usage logged)", async () => {
    const { doc, patient } = await setup();
    const fake = fakeProvider([JSON.stringify(VALID)]);
    setAiProvider(fake.provider);

    const res = await doc.post(`/api/v1/patients/${patient._id}/ai-summary`).send({});
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ label: "AI-generated — verify before use", content: VALID, stale: false });

    const sent = fake.requests[0].prompt;
    for (const identifier of ["Rahima", "Akter", "01711223344", "1711223344", patient.patientCode, "Keraniganj"])
      expect(sent).not.toContain(identifier);
    expect(sent).toContain('"gender":"female"');
    expect(sent).toContain("Amlodipine");
    expect(await AiUsageModel.countDocuments({ feature: "visit-summary", status: "ok" })).toBe(1);
    expect(await AuditLogModel.countDocuments({ entityType: "AiSummary", action: "CREATE" })).toBe(1);
  });

  it("reuses the cached summary until a new visit closes, then marks it stale", async () => {
    const { doc, patient, closeVisit } = await setup();
    const fake = fakeProvider([JSON.stringify(VALID)]);
    setAiProvider(fake.provider);

    await doc.post(`/api/v1/patients/${patient._id}/ai-summary`).send({});
    await doc.post(`/api/v1/patients/${patient._id}/ai-summary`).send({});
    expect(fake.requests).toHaveLength(1);

    await closeVisit(2);
    const view = await doc.get(`/api/v1/patients/${patient._id}/ai-summary`);
    expect(view.body.data.summary).toMatchObject({ stale: true, staleReason: "A new visit was closed" });

    await doc.post(`/api/v1/patients/${patient._id}/ai-summary`).send({});
    expect(fake.requests).toHaveLength(2);
  });

  it("a slow provider times out with a safe message", async () => {
    const { doc, patient } = await setup();
    setAiProvider(fakeProvider([() => new Promise<never>(() => undefined)]).provider);
    aiSettings.timeoutMs = 50;

    const res = await doc.post(`/api/v1/patients/${patient._id}/ai-summary`).send({});
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("AI_UNAVAILABLE");
    expect(await AiUsageModel.countDocuments({ status: "timeout" })).toBe(1);
  });

  it("an answer that is not the expected JSON is retried once, then refused", async () => {
    const { doc, patient } = await setup();
    const fake = fakeProvider(["Sure! Here is the summary: the patient is fine.", '{"summary": 42}']);
    setAiProvider(fake.provider);

    const res = await doc.post(`/api/v1/patients/${patient._id}/ai-summary`).send({});
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("AI_INVALID_OUTPUT");
    expect(fake.requests).toHaveLength(2);
    expect(await AiUsageModel.countDocuments({ status: "invalid_output" })).toBe(1);
  });

  it("without a configured provider the screen is told, and generation is refused", async () => {
    const { doc, patient } = await setup();
    setAiProvider(null);
    expect((await doc.get(`/api/v1/patients/${patient._id}/ai-summary`)).body.data).toEqual({
      configured: false,
      summary: null,
    });
    const res = await doc.post(`/api/v1/patients/${patient._id}/ai-summary`).send({});
    expect(res.body.error.code).toBe("AI_NOT_CONFIGURED");
  });

  it("only the patient's own doctor may generate it", async () => {
    const { patient } = await setup();
    setAiProvider(fakeProvider([JSON.stringify(VALID)]).provider);
    const other = await createUser({ role: "doctor", email: "other@test.local" });
    await createClinic({ userId: other._id, departmentName: "ENT", doctorName: "Other Doctor" });
    const stranger = await signIn("other@test.local");
    expect((await stranger.post(`/api/v1/patients/${patient._id}/ai-summary`).send({})).status).toBe(403);
  });
});
