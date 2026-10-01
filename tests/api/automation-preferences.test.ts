import { HospitalSettingsModel } from "../../src/modules/hospital/settings/settings.model";
import { clearSettingsCache } from "../../src/modules/hospital/settings/settings.service";
import { PatientModel } from "../../src/modules/patients/patient.model";
import { dispatchDue } from "../../src/modules/automation/dispatcher";
import { planJobs } from "../../src/modules/automation/jobs";
import { AutomationJobModel } from "../../src/modules/automation/models/job.model";
import { AutomationRuleSettingModel } from "../../src/modules/automation/models/ruleSetting.model";
import { ensureDefaultTemplates } from "../../src/modules/automation/templates/template.service";
import { createPatients } from "../fixtures";
import { useFakeWhatsApp } from "../fake-whatsapp";
import { createUser, signIn, useTestDatabase } from "../helpers";

describe("patient message preferences", () => {
  useTestDatabase();
  useFakeWhatsApp();

  beforeEach(async () => {
    await ensureDefaultTemplates();
    await HospitalSettingsModel.updateOne(
      { key: "default" },
      { $set: { quietHoursStart: "00:00", quietHoursEnd: "00:00" } },
    );
    clearSettingsCache();
  });

  it("reception changes preferences on the patient's request; the profile shows them; others cannot", async () => {
    const [patient] = await createPatients(1);
    await createUser({ role: "reception", email: "rec@test.local" });
    await createUser({ role: "pharmacist", email: "ph@test.local" });
    const rec = await signIn("rec@test.local");
    const ph = await signIn("ph@test.local");

    const res = await rec
      .patch(`/api/v1/patients/${patient._id}/preferences`)
      .send({ followUps: false, language: "en" });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ followUps: false, reminders: true, language: "en", marketing: false });

    const stop = await rec.patch(`/api/v1/patients/${patient._id}/preferences`).send({ optOutAll: true });
    expect(stop.body.data.optOutAll).toBe(true);
    expect(stop.body.data.optOutReason).toMatch(/Set by/);
    expect((await rec.get(`/api/v1/patients/${patient._id}`)).body.data.preferences.optOutAll).toBe(true);

    expect((await ph.patch(`/api/v1/patients/${patient._id}/preferences`).send({ marketing: true })).status).toBe(403);
    expect((await rec.patch(`/api/v1/patients/${patient._id}/preferences`).send({ unknown: 1 })).status).toBe(400);
  });

  it("marketing is opt-in only and never sent after STOP", async () => {
    const [patient] = await createPatients(1);
    await AutomationRuleSettingModel.create({ key: "birthday_greeting", enabled: true, config: {} });
    await planJobs("birthday_greeting", [
      {
        dedupeKey: `bday:${patient._id}:2026`,
        scopeType: "patient",
        scopeId: String(patient._id),
        scheduledFor: new Date(Date.now() - 1000),
        patientId: String(patient._id),
      },
    ]);
    // Marketing is opt-in: not opted in → skipped
    expect(await dispatchDue()).toMatchObject({ skipped: 1 });
    expect(
      (await AutomationJobModel.findOne().lean<{ decisions: { reason: string; detail: string }[] }>())!.decisions[0],
    ).toMatchObject({
      reason: "optOut",
      detail: "Marketing needs the patient's opt-in",
    });

    // Opted in → sent; but never after STOP
    await PatientModel.updateOne({ _id: patient._id }, { $set: { "preferences.marketing": true } });
    await planJobs("birthday_greeting", [
      {
        dedupeKey: `bday:${patient._id}:2027`,
        scopeType: "patient",
        scopeId: String(patient._id),
        scheduledFor: new Date(Date.now() - 1000),
        patientId: String(patient._id),
      },
    ]);
    expect(await dispatchDue()).toMatchObject({ sent: 1 });
    await PatientModel.updateOne({ _id: patient._id }, { $set: { "preferences.optOutAll": true } });
    await planJobs("birthday_greeting", [
      {
        dedupeKey: `bday:${patient._id}:2028`,
        scopeType: "patient",
        scopeId: String(patient._id),
        scheduledFor: new Date(Date.now() - 1000),
        patientId: String(patient._id),
      },
    ]);
    expect(await dispatchDue()).toMatchObject({ skipped: 1 });
  });
});
