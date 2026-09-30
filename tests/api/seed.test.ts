import { seedDemoUsers } from "../../src/DB/demoUsers";
import { linkDemoDoctor, seedHospitalData } from "../../src/DB/hospitalSeed";
import { seedClinicalHistory } from "../../src/DB/seed-data/clinicalHistory";
import { seedDemoActivity } from "../../src/DB/seed-data/demoActivity";
import { seedAssistantDemo } from "../../src/DB/seed-data/assistantDemo";
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
  }, 120_000);
});
