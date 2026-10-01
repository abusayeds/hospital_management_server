import { seedDemoUsers } from "../../src/DB/demoUsers";
import { linkDemoDoctor, seedHospitalData } from "../../src/DB/hospitalSeed";
import { seedClinicalHistory } from "../../src/DB/seed-data/clinicalHistory";
import { seedDemoActivity } from "../../src/DB/seed-data/demoActivity";
import { seedAssistantDemo } from "../../src/DB/seed-data/assistantDemo";
import { seedAutomationDemo } from "../../src/DB/seed-data/automationDemo";
import { HospitalSettingsModel } from "../../src/modules/hospital/settings/settings.model";
import { clearSettingsCache } from "../../src/modules/hospital/settings/settings.service";
import { dispatchDue } from "../../src/modules/automation/dispatcher";
import { runPlanner } from "../../src/modules/automation/engine";
import { AutomationJobModel } from "../../src/modules/automation/models/job.model";
import { OutboxMessageModel } from "../../src/modules/automation/models/outbox.model";
import { allRules } from "../../src/modules/automation/rules/registry";
import { ConversationModel } from "../../src/modules/assistant/conversation.model";
import { LabOrderModel } from "../../src/modules/clinical/lab/labOrder.model";
import { PrescriptionTemplateModel, VisitModel } from "../../src/modules/clinical/visits/visit.model";
import { useTestDatabase } from "../helpers";

describe("Demo seed", () => {
  useTestDatabase();

  it("creates clinical history with lab orders in every working status, and is idempotent", async () => {
    await seedHospitalData();
    await seedDemoUsers("Demo12345");
    await linkDemoDoctor();
    await seedDemoActivity();
    await seedClinicalHistory();

    const visits = await VisitModel.countDocuments();
    expect(visits).toBeGreaterThan(0);
    expect(await VisitModel.countDocuments({ status: { $ne: "closed" } })).toBe(0);
    expect(await VisitModel.countDocuments({ "addenda.0": { $exists: true } })).toBe(1);
    expect(await PrescriptionTemplateModel.countDocuments()).toBeGreaterThan(0);
    const statuses = await LabOrderModel.distinct("status");
    expect(statuses).toEqual(expect.arrayContaining(["ready", "delivered"]));

    await seedClinicalHistory();
    expect(await VisitModel.countDocuments()).toBe(visits);

    await seedAssistantDemo();
    expect(await ConversationModel.countDocuments({ emergency: true })).toBe(1);
    expect(await ConversationModel.countDocuments({ status: "needs_human" })).toBe(2);
    await seedAssistantDemo();
    expect(await ConversationModel.countDocuments()).toBe(4);

    // Automation demo: outbox history, a retryable failure, and real jobs that send at once (simulated)
    await HospitalSettingsModel.updateOne(
      { key: "default" },
      { $set: { quietHoursStart: "00:00", quietHoursEnd: "00:00" } },
    );
    clearSettingsCache();
    await seedAutomationDemo();
    const history = await OutboxMessageModel.countDocuments();
    expect(history).toBe(7);
    expect(await AutomationJobModel.countDocuments({ status: "failed" })).toBe(1);
    await seedAutomationDemo();
    expect(await OutboxMessageModel.countDocuments()).toBe(history);

    for (const rule of allRules()) await runPlanner(rule);
    await AutomationJobModel.updateMany({ ruleKey: "no_show_rebook" }, { $set: { scheduledFor: new Date() } });
    const sent = await dispatchDue();
    expect(sent.sent).toBeGreaterThanOrEqual(4); // confirmation, follow-up, lab ready, no-show (+ same-day if due)
    const rules = await OutboxMessageModel.distinct("ruleKey", { status: "sent", simulated: true });
    expect(rules).toEqual(
      expect.arrayContaining(["appointment_confirmation", "follow_up_reminder", "lab_report_ready", "no_show_rebook"]),
    );
  }, 120_000);
});
