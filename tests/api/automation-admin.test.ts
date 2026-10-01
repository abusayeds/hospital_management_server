import { HospitalSettingsModel } from "../../src/modules/hospital/settings/settings.model";
import { clearSettingsCache } from "../../src/modules/hospital/settings/settings.service";
import { dispatchDue } from "../../src/modules/automation/dispatcher";
import { handleRuleEvent } from "../../src/modules/automation/engine";
import { AutomationJobModel } from "../../src/modules/automation/models/job.model";
import { getRule } from "../../src/modules/automation/rules/registry";
import { ensureDefaultTemplates } from "../../src/modules/automation/templates/template.service";
import { addDays, todayInDhaka } from "../../src/utils/date";
import { createAppointment, createClinic, createPatients } from "../fixtures";
import { createUser, signIn, useTestDatabase } from "../helpers";

describe("automation admin API", () => {
  useTestDatabase();

  const admin = async () => {
    await createUser({ role: "super_admin", email: "admin@test.local" });
    return signIn("admin@test.local");
  };

  beforeEach(async () => {
    await ensureDefaultTemplates();
    await HospitalSettingsModel.updateOne(
      { key: "default" },
      { $set: { quietHoursStart: "00:00", quietHoursEnd: "00:00", simulateWhatsApp: true } },
    );
    clearSettingsCache();
  });

  const sendOneConfirmation = async () => {
    const clinic = await createClinic();
    const [patient] = await createPatients(1);
    const a = await createAppointment({
      patient,
      doctor: clinic.doctor,
      date: addDays(todayInDhaka(), 1),
      status: "booked",
    });
    await handleRuleEvent(getRule("appointment_confirmation")!, "appointment.booked", {
      appointmentId: String(a._id),
      patientId: String(patient._id),
      doctorId: String(clinic.doctor._id),
      date: a.date,
      slotTime: a.slotTime,
      source: "reception",
    });
    await dispatchDue();
    return { patient, appointment: a };
  };

  it("management can read but not change; reception cannot open it", async () => {
    await createUser({ role: "management", email: "mgmt@test.local" });
    await createUser({ role: "reception", email: "rec@test.local" });
    const mgmt = await signIn("mgmt@test.local");
    const rec = await signIn("rec@test.local");
    const rules = await mgmt.get("/api/v1/automation/rules");
    expect(rules.status).toBe(200);
    expect(rules.body.data.map((r: { key: string }) => r.key)).toContain("reminder_day_before");
    expect((await mgmt.patch("/api/v1/automation/rules/reminder_day_before").send({ enabled: false })).status).toBe(
      403,
    );
    expect((await rec.get("/api/v1/automation/outbox")).status).toBe(403);
  });

  it("admin toggles a rule and changes its timing with validation", async () => {
    const a = await admin();
    const bad = await a.patch("/api/v1/automation/rules/reminder_day_before").send({ config: { sendAt: "25:99" } });
    expect(bad.status).toBe(400);
    const res = await a
      .patch("/api/v1/automation/rules/reminder_day_before")
      .send({ enabled: false, config: { sendAt: "19:30" } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ enabled: false, config: { sendAt: "19:30" } });
  });

  it("templates: undeclared variables are rejected at save; versions can be rolled back", async () => {
    const a = await admin();
    const bad = await a
      .patch("/api/v1/automation/templates/no_show_rebook")
      .send({ bodies: { bn: "{{patientName}} {{diagnosis}}", en: "x" } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/diagnosis/);

    const saved = await a
      .patch("/api/v1/automation/templates/no_show_rebook")
      .send({ bodies: { bn: "নতুন লেখা {{patientName}}", en: "New text {{patientName}}" } });
    expect(saved.body.data.version).toBe(2);
    const back = await a.post("/api/v1/automation/templates/no_show_rebook/rollback").send({ version: 1 });
    expect(back.body.data.version).toBe(3);
    expect(back.body.data.bodies.en).toMatch(/we missed you/);
  });

  it("outbox list, detail, CSV export (phones masked) and the next-hour queue", async () => {
    const a = await admin();
    await sendOneConfirmation();
    const list = await a.get("/api/v1/automation/outbox?ruleKey=appointment_confirmation");
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].to).toMatch(/•••/);
    const detail = await a.get(`/api/v1/automation/outbox/${list.body.data[0].id}`);
    expect(detail.body.data.job.decisions.at(-1).reason).toBe("sent");
    const csv = await a.get("/api/v1/automation/outbox/export.csv");
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.text).toContain("appointment_confirmation");
    expect(csv.text).not.toMatch(/\+8801\d{9}/);

    await AutomationJobModel.create({
      ruleKey: "reminder_day_before",
      dedupeKey: "apt:x:T-1d",
      scopeType: "appointment",
      scopeId: "x",
      scheduledFor: new Date(Date.now() + 10 * 60_000),
      originalScheduledFor: new Date(),
    });
    const queue = await a.get("/api/v1/automation/queue?minutes=60");
    expect(queue.body.data).toHaveLength(1);
    const cancelled = await a.post(`/api/v1/automation/jobs/${queue.body.data[0].id}/cancel`).send({});
    expect(cancelled.body.data.status).toBe("cancelled");
  });

  it("settings: switch simulation and quiet hours; health reports the queue", async () => {
    const a = await admin();
    const res = await a
      .patch("/api/v1/automation/settings")
      .send({ simulateWhatsApp: false, quietHoursStart: "22:00" });
    expect(res.body.data).toMatchObject({ simulateWhatsApp: false, quietHoursStart: "22:00" });
    const health = await a.get("/api/v1/automation/health");
    expect(health.body.data).toMatchObject({ queueDepth: 0, simulation: { whatsapp: false } });
  });

  it("preview world lists what would be sent without storing anything", async () => {
    const a = await admin();
    const clinic = await createClinic();
    const [patient] = await createPatients(1);
    const tomorrow = addDays(todayInDhaka(), 1);
    const appt = await createAppointment({ patient, doctor: clinic.doctor, date: tomorrow, status: "booked" });
    await appt.collection.updateOne({ _id: appt._id }, { $set: { createdAt: new Date(Date.now() - 2 * 864e5) } });
    const at = new Date(Date.now() + 23 * 3600e3).toISOString();
    const res = await a.post("/api/v1/automation/preview-world").send({ at });
    expect(res.status).toBe(200);
    const reminder = res.body.data.find((r: { ruleKey: string }) => r.ruleKey === "reminder_day_before");
    expect(reminder).toBeTruthy();
    expect(reminder.text).toContain("Test Doctor");
    expect(await AutomationJobModel.countDocuments()).toBe(0);
  });

  it("patient Messages tab shows the outbox timeline", async () => {
    const a = await admin();
    await createUser({ role: "reception", email: "rec2@test.local" });
    const rec = await signIn("rec2@test.local");
    const { patient } = await sendOneConfirmation();
    const res = await rec.get(`/api/v1/automation/patients/${patient._id}/messages`);
    expect(res.status).toBe(200);
    expect(res.body.data.items[0]).toMatchObject({ kind: "outbox", ruleKey: "appointment_confirmation" });
    expect(res.body.data.preferences.reminders).toBe(true);
    expect((await a.get(`/api/v1/automation/patients/${patient._id}/messages`)).status).toBe(403); // admin: no patient access
  });
});
