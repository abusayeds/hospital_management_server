import { closePdfBrowser } from "../../src/documents/pdf";
import { drainEvents } from "../../src/events/bus";
import { DomainEventModel } from "../../src/events/domainEvent.model";
import { AuditLogModel } from "../../src/modules/audit/auditLog.model";
import { LabTestModel } from "../../src/modules/hospital/catalog/catalog.models";
import { HospitalSettingsModel } from "../../src/modules/hospital/settings/settings.model";
import { clearSettingsCache } from "../../src/modules/hospital/settings/settings.service";
import { createAppointment, createClinic, createPatients } from "../fixtures";
import { createUser, signIn, useTestDatabase } from "../helpers";

describe("Lab workflow", () => {
  useTestDatabase();
  afterAll(() => closePdfBrowser());

  /** Doctor closes a visit with CBC in investigations → the lab gets an order */
  const orderedCbc = async () => {
    const doctorUser = await createUser({ role: "doctor", email: "doc@test.local" });
    await createUser({ role: "lab_technician", email: "lab1@test.local" });
    await createUser({ role: "lab_technician", email: "lab2@test.local" });
    const { doctor } = await createClinic({ userId: doctorUser._id });
    const [patient] = await createPatients(1);
    const cbc = await LabTestModel.create({
      name: "Complete Blood Count",
      code: "CBC",
      category: "Haematology",
      price: 40000,
      sampleType: "Blood (EDTA)",
      turnaroundHours: 4,
      parameters: [
        { name: "Haemoglobin", unit: "g/dL", normalMin: 12, normalMax: 16 },
        { name: "WBC", unit: "×10⁹/L", normalMin: 4, normalMax: 11 },
      ],
    });
    const appt = await createAppointment({ patient, doctor, status: "checked_in" });
    const doc = await signIn("doc@test.local");
    const visitId = (await doc.post(`/api/v1/appointments/${appt._id}/visit`)).body.data.id;
    await doc.patch(`/api/v1/visits/${visitId}`).send({
      provisionalDiagnosis: "Anaemia?",
      investigations: [{ labTestId: String(cbc._id), name: cbc.name }],
    });
    await doc.post(`/api/v1/visits/${visitId}/close`);
    const lab1 = await signIn("lab1@test.local");
    const lab2 = await signIn("lab2@test.local");
    const board = await lab1.get("/api/v1/lab-orders/board");
    return { doc, lab1, lab2, patient, cbc, order: board.body.data[0] };
  };

  const enterAndSubmit = async (lab: Awaited<ReturnType<typeof signIn>>, orderId: string, labTestId: string) => {
    await lab.post(`/api/v1/lab-orders/${orderId}/collect`);
    const saved = await lab.patch(`/api/v1/lab-orders/${orderId}/results`).send({
      tests: [
        {
          labTestId,
          results: [
            { name: "Haemoglobin", value: "9.5" },
            { name: "WBC", value: "7" },
          ],
        },
      ],
    });
    await lab.post(`/api/v1/lab-orders/${orderId}/submit`);
    return saved;
  };

  it("closing a visit orders its catalogue tests and publishes lab.order_created", async () => {
    const { order } = await orderedCbc();
    expect(order).toMatchObject({
      status: "ordered",
      orderNo: expect.stringMatching(/^LAB-/),
      clinicalNote: "Anaemia?",
    });
    expect(order.tests[0].results.map((r: { name: string }) => r.name)).toEqual(["Haemoglobin", "WBC"]);
    await drainEvents();
    expect(await DomainEventModel.countDocuments({ name: "lab.order_created" })).toBe(1);
  });

  it("flags results from the catalogue range and refuses to submit with blanks", async () => {
    const { lab1, order, cbc } = await orderedCbc();
    await lab1.post(`/api/v1/lab-orders/${order.id}/collect`);
    const saved = await lab1
      .patch(`/api/v1/lab-orders/${order.id}/results`)
      .send({ tests: [{ labTestId: String(cbc._id), results: [{ name: "Haemoglobin", value: "9.5" }] }] });
    expect(saved.body.data).toMatchObject({ status: "processing", worstFlag: "low" });
    expect(saved.body.data.tests[0].results[0].flag).toBe("low");

    const submit = await lab1.post(`/api/v1/lab-orders/${order.id}/submit`);
    expect(submit.status).toBe(400);
    expect(submit.body.error.message).toContain("WBC");
  });

  it("four-eyes: the person who entered results cannot verify them; a colleague can", async () => {
    const { lab1, lab2, order, cbc } = await orderedCbc();
    await enterAndSubmit(lab1, order.id, String(cbc._id));

    const self = await lab1.post(`/api/v1/lab-orders/${order.id}/verify`);
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe("FOUR_EYES_REQUIRED");
    expect(await AuditLogModel.countDocuments({ action: "PERMISSION_DENIED", "meta.reason": "four_eyes" })).toBe(1);

    const other = await lab2.post(`/api/v1/lab-orders/${order.id}/verify`);
    expect(other.status).toBe(200);
    expect(other.body.data).toMatchObject({ status: "ready", verifiedBy: { name: expect.any(String) } });
    await drainEvents();
    expect(await DomainEventModel.findOne({ name: "lab.report_ready" })).toBeTruthy();
  });

  it("with the four-eyes setting off, one person may enter and verify", async () => {
    const { lab1, order, cbc } = await orderedCbc();
    await HospitalSettingsModel.updateOne({ key: "default" }, { $set: { labFourEyes: false } }, { upsert: true });
    clearSettingsCache();
    await enterAndSubmit(lab1, order.id, String(cbc._id));
    expect((await lab1.post(`/api/v1/lab-orders/${order.id}/verify`)).status).toBe(200);
  });

  it("the verifier can send results back with a reason", async () => {
    const { lab1, lab2, order, cbc } = await orderedCbc();
    await enterAndSubmit(lab1, order.id, String(cbc._id));
    const back = await lab2.post(`/api/v1/lab-orders/${order.id}/reject`).send({ reason: "Haemolysed sample" });
    expect(back.body.data.status).toBe("processing");
    expect(back.body.data.history.at(-1).note).toContain("Haemolysed sample");
  });

  it("the doctor sees results only after verification, and can print the verified report", async () => {
    const { doc, lab1, lab2, order, cbc, patient } = await orderedCbc();
    await enterAndSubmit(lab1, order.id, String(cbc._id));

    const early = await doc.get(`/api/v1/lab-orders/${order.id}`);
    expect(early.body.data.tests[0].results).toEqual([]);
    expect((await doc.get(`/api/v1/lab-orders/${order.id}/report.pdf`)).status).toBe(409);

    await lab2.post(`/api/v1/lab-orders/${order.id}/verify`);
    const history = await doc.get(`/api/v1/patients/${patient._id}/lab-orders`);
    expect(history.body.data[0].tests[0].results[0]).toMatchObject({ value: "9.5", flag: "low" });

    const pdf = await doc.get(`/api/v1/lab-orders/${order.id}/report.pdf`).buffer(true);
    expect(pdf.status).toBe(200);
    expect(Buffer.from(pdf.body).subarray(0, 4).toString()).toBe("%PDF");
  }, 60_000);
});
