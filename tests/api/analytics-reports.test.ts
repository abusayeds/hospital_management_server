import { setAiProvider } from "../../src/ai/ai.service";
import type { AiProvider, AiRequest } from "../../src/ai/provider";
import { AuditLogModel } from "../../src/modules/audit/auditLog.model";
import { OutboxMessageModel } from "../../src/modules/automation/models/outbox.model";
import { DepartmentModel } from "../../src/modules/hospital/department/department.model";
import { OperationalReportModel } from "../../src/modules/reports/operationalReport.model";
import { addDays, todayInDhaka } from "../../src/utils/date";
import { createAppointment, createClinic, createPatients } from "../fixtures";
import { createUser, signIn, useTestDatabase } from "../helpers";

/** A fake AI that answers with `text` and remembers every prompt it was sent */
const fakeAi = (text: string | (() => never)) => {
  const prompts: AiRequest[] = [];
  const provider: AiProvider = {
    name: "fake",
    generate: async (req) => {
      prompts.push(req);
      if (typeof text === "function") text();
      return { text: text as string, model: "fake-model" };
    },
  };
  setAiProvider(provider);
  return prompts;
};

describe("Management analytics and the AI daily report", () => {
  useTestDatabase();
  afterEach(() => setAiProvider(undefined));

  /** Today: 1 completed, 1 no-show, 1 still booked — for patients whose identifiers must never leak */
  const day = async () => {
    await createUser({ role: "management", email: "mgmt@test.local" });
    await createUser({ role: "reception", email: "rec@test.local" });
    const { doctor, department } = await createClinic({ doctorName: "Karim Uddin" });
    const patients = await createPatients(3);
    await createAppointment({ patient: patients[0], doctor, status: "completed", serialNo: 1 });
    await createAppointment({ patient: patients[1], doctor, status: "no_show", serialNo: 2, slotTime: "09:10" });
    await createAppointment({ patient: patients[2], doctor, status: "booked", serialNo: 3, slotTime: "09:20" });
    const mgmt = await signIn("mgmt@test.local");
    return { mgmt, patients, doctor, department };
  };

  const identifiersOf = (patients: { name: string; phone: string; patientCode: string }[]) =>
    patients.flatMap((p) => [p.name, p.phone, p.phone.slice(-10), p.patientCode]);
  const expectNoIdentifiers = (blob: unknown, ids: string[]) => {
    const text = JSON.stringify(blob);
    for (const id of ids) expect(text).not.toContain(id);
  };

  // ------------------------------------------------------------------ analytics

  it("today's KPIs count appointments by outcome", async () => {
    const { mgmt } = await day();
    const res = await mgmt.get("/api/v1/analytics/kpis");
    expect(res.status).toBe(200);
    expect(res.body.data.appointments).toMatchObject({
      total: 3,
      completed: 1,
      noShow: 1,
      booked: 1,
      noShowRate: 33.3,
    });
  });

  it("trends, doctor and department stats carry counts and names — never patient identifiers", async () => {
    const { mgmt, patients } = await day();
    const q = `from=${addDays(todayInDhaka(), -6)}&to=${todayInDhaka()}`;
    const ids = identifiersOf(patients);
    for (const path of [
      "trend/appointments",
      "trend/revenue",
      "doctor-stats",
      "department-stats",
      "doctor-heatmap",
      "lab-frequency",
      "lead-time",
      "chat-volume",
      "queue/now",
    ]) {
      const res = await mgmt.get(`/api/v1/analytics/${path}?${q}`);
      expect(res.status).toBe(200);
      expectNoIdentifiers(res.body.data, ids);
    }
    const trend = (await mgmt.get(`/api/v1/analytics/trend/appointments?${q}`)).body.data;
    expect(trend).toHaveLength(7); // zero-filled days
    const doctors = (await mgmt.get(`/api/v1/analytics/doctor-stats?${q}`)).body.data;
    expect(doctors[0]).toMatchObject({ name: expect.stringContaining("Karim Uddin"), patientCount: 1, noShows: 1 });
  });

  it("analytics need report:operations; a backwards range is refused", async () => {
    const { mgmt } = await day();
    const rec = await signIn("rec@test.local");
    expect((await rec.get("/api/v1/analytics/kpis")).status).toBe(403);
    expect(
      (await mgmt.get(`/api/v1/analytics/doctor-stats?from=${todayInDhaka()}&to=${addDays(todayInDhaka(), -3)}`))
        .status,
    ).toBe(400);
  });

  it("CSV export is audited and neutralises spreadsheet formulas", async () => {
    const { mgmt, department } = await day();
    await DepartmentModel.updateOne({ _id: department._id }, { $set: { name: '=HYPERLINK("http://evil")' } });
    const res = await mgmt.get(
      `/api/v1/analytics/export.csv?report=department-stats&from=${todayInDhaka()}&to=${todayInDhaka()}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.text).toContain("'=HYPERLINK");
    expect(await AuditLogModel.countDocuments({ action: "EXPORT", entityType: "Analytics" })).toBe(1);
  });

  // ------------------------------------------------------------------ AI daily report

  it("without an AI provider the report falls back to the Bangla bullet summary", async () => {
    const { mgmt, patients } = await day();
    setAiProvider(null);
    const res = await mgmt.post("/api/v1/reports/daily/generate").send({ date: todayInDhaka() });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ source: "fallback", fallbackReason: expect.any(String) });
    expect(res.body.data.bullets[0]).toContain("অ্যাপয়েন্টমেন্ট: মোট 3টি");
    expectNoIdentifiers(res.body.data, identifiersOf(patients));
  });

  it("the AI gets aggregated numbers only, and its narrative is stored with the prompt version", async () => {
    const { mgmt, patients } = await day();
    const prompts = fakeAi(
      JSON.stringify({
        narrative: "আজ মোট ৩টি অ্যাপয়েন্টমেন্ট ছিল; একজন রোগী আসেননি এবং একজনের পরামর্শ সম্পন্ন হয়েছে।",
        highlights: ["অনুপস্থিতির হার ৩৩%"],
      }),
    );
    const res = await mgmt.post("/api/v1/reports/daily/generate").send({ date: todayInDhaka() });
    expect(res.body.data).toMatchObject({ source: "ai", model: "fake-model", promptVersion: "daily-report.v1" });
    expect(prompts).toHaveLength(1);
    expectNoIdentifiers(prompts[0].prompt, identifiersOf(patients));
    expect(prompts[0].prompt).toContain('"noShow":1');
  });

  it("AI text that looks like it holds a phone number is rejected (fallback); AI errors fall back too", async () => {
    const { mgmt } = await day();
    fakeAi(
      JSON.stringify({
        narrative: "আজ একজন রোগী 01712345678 নম্বর থেকে ফোন করেছিলেন এবং মোট ৩টি অ্যাপয়েন্টমেন্ট ছিল।",
        highlights: [],
      }),
    );
    const leaked = await mgmt.post("/api/v1/reports/daily/generate").send({ date: todayInDhaka() });
    expect(leaked.body.data).toMatchObject({ source: "fallback", fallbackReason: expect.stringContaining("privacy") });

    fakeAi(() => {
      throw new Error("provider down");
    });
    const failed = await mgmt.post("/api/v1/reports/daily/generate").send({ date: todayInDhaka() });
    expect(failed.body.data.source).toBe("fallback");
    expect(await OperationalReportModel.countDocuments()).toBe(1); // regenerating replaces the day's report
  });

  it("generate defaults to yesterday, refuses the future, and resend notifies management in-app", async () => {
    const { mgmt } = await day();
    const made = await mgmt.post("/api/v1/reports/daily/generate").send({});
    expect(made.body.data.date).toBe(addDays(todayInDhaka(), -1));
    expect((await mgmt.post("/api/v1/reports/daily/generate").send({ date: addDays(todayInDhaka(), 1) })).status).toBe(
      400,
    );

    const sent = await mgmt.post(`/api/v1/reports/daily/${made.body.data.date}/resend`);
    expect(sent.status).toBe(200);
    const notice = await OutboxMessageModel.findOne({
      ruleKey: "daily_ai_report",
      toRef: "perm:report:operations",
    }).lean();
    expect(notice?.renderedText).toContain("Management → Reports");
    expect(sent.body.data.deliveryCount).toBe(1);

    const list = await mgmt.get("/api/v1/reports/daily");
    expect(list.body.data).toHaveLength(1);
    const rec = await signIn("rec@test.local");
    expect((await rec.get("/api/v1/reports/daily")).status).toBe(403);
  });
});
