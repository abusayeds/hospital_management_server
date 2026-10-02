import { drainEvents } from "../../src/events/bus";
import { AuditLogModel } from "../../src/modules/audit/auditLog.model";
import { OutboxMessageModel } from "../../src/modules/automation/models/outbox.model";
import { InvoiceModel } from "../../src/modules/billing/invoice.model";
import { MedicineModel } from "../../src/modules/hospital/catalog/catalog.models";
import { MedicineBatchModel, StockMovementModel } from "../../src/modules/pharmacy/pharmacy.models";
import { dosesPerDay, suggestQuantity } from "../../src/modules/pharmacy/pharmacy.service";
import { addDays, todayInDhaka } from "../../src/utils/date";
import { createAppointment, createClinic, createPatients } from "../fixtures";
import { createUser, signIn, useTestDatabase } from "../helpers";

describe("quantity suggestion", () => {
  it("reads dose patterns and multiplies by days for tablets only", () => {
    expect(dosesPerDay("1+0+1")).toBe(2);
    expect(dosesPerDay("½+0+½")).toBe(1);
    expect(dosesPerDay("1/2+1/2+1")).toBe(2);
    expect(dosesPerDay("as needed")).toBeNull();
    expect(suggestQuantity({ dosePattern: "1+1+1", durationDays: 5, form: "tablet" })).toBe(15);
    expect(suggestQuantity({ dosePattern: "0+0+1", durationDays: 7, form: "syrup" })).toBe(1);
    expect(suggestQuantity({ dosePattern: "1+0+1", durationDays: null, form: "capsule" })).toBe(1);
  });
});

describe("Pharmacy", () => {
  useTestDatabase();

  const today = todayInDhaka();
  const setup = async () => {
    await createUser({ role: "pharmacist", email: "ph@test.local" });
    await createUser({ role: "reception", email: "rec@test.local" });
    const napa = await MedicineModel.create({
      brandName: "Napa",
      genericName: "Paracetamol",
      strength: "500 mg",
      form: "tablet",
      reorderLevel: 10,
    });
    const ph = await signIn("ph@test.local");
    return { ph, napa };
  };

  /** Receive stock: two batches, the LATER expiry bought first */
  const receive = async (ph: Awaited<ReturnType<typeof signIn>>, medicineId: string) => {
    const res = await ph.post("/api/v1/pharmacy/purchases").send({
      supplier: "Beximco Distribution",
      supplierInvoiceNo: "BX-778",
      date: today,
      items: [
        { medicineId, batchNo: "late01", expiryDate: addDays(today, 400), quantity: 30, unitCost: 80, unitPrice: 120 },
        { medicineId, batchNo: "SOON01", expiryDate: addDays(today, 60), quantity: 12, unitCost: 80, unitPrice: 100 },
      ],
    });
    expect(res.status).toBe(201);
    return res.body.data;
  };

  /** A doctor signs a prescription with Napa 1+0+1 for 5 days (= 10 tablets) */
  const prescription = async (napaId: string) => {
    const doctorUser = await createUser({ role: "doctor", email: "doc@test.local" });
    const { doctor } = await createClinic({ userId: doctorUser._id });
    const [patient] = await createPatients(1);
    const appt = await createAppointment({ patient, doctor, status: "checked_in" });
    const doc = await signIn("doc@test.local");
    const visitId = (await doc.post(`/api/v1/appointments/${appt._id}/visit`)).body.data.id as string;
    await doc.patch(`/api/v1/visits/${visitId}`).send({
      provisionalDiagnosis: "Viral fever",
      prescription: [
        {
          medicineId: napaId,
          brandName: "Napa",
          genericName: "Paracetamol",
          strength: "500 mg",
          form: "tablet",
          dosePattern: "1+0+1",
          durationDays: 5,
        },
      ],
    });
    expect((await doc.post(`/api/v1/visits/${visitId}/close`)).status).toBe(200);
    return { visitId, patient };
  };

  it("a purchase receives stock as batches with movements; bad lines are refused", async () => {
    const { ph, napa } = await setup();
    const p = await receive(ph, String(napa._id));
    expect(p).toMatchObject({ purchaseNo: expect.stringMatching(/^PUR-/), total: 42 * 80 });
    expect(p.items[0].batchNo).toBe("LATE01"); // normalised

    const stock = (await ph.get("/api/v1/pharmacy/stock?q=napa")).body.data[0];
    expect(stock).toMatchObject({
      inStock: 42,
      batchCount: 2,
      nearestExpiry: addDays(today, 60),
      unitPrice: 100,
      status: "ok",
    });
    expect(await StockMovementModel.countDocuments({ type: "purchase" })).toBe(2);

    const bad = (item: object) =>
      ph.post("/api/v1/pharmacy/purchases").send({
        supplier: "X Pharma",
        date: today,
        items: [
          {
            medicineId: String(napa._id),
            batchNo: "B1",
            quantity: 5,
            unitCost: 100,
            unitPrice: 150,
            expiryDate: addDays(today, 100),
            ...item,
          },
        ],
      });
    expect((await bad({ unitPrice: 90 })).status).toBe(400); // below cost
    expect((await bad({ expiryDate: today })).status).toBe(400); // already expired
  });

  it("the queue lists signed prescriptions; the detail suggests quantities and shows stock — never the diagnosis", async () => {
    const { ph, napa } = await setup();
    await receive(ph, String(napa._id));
    const { visitId } = await prescription(String(napa._id));

    const queue = (await ph.get("/api/v1/pharmacy/prescriptions")).body.data;
    expect(queue[0]).toMatchObject({ visitId, status: "pending", medicines: 1 });

    const detail = (await ph.get(`/api/v1/pharmacy/prescriptions/${visitId}`)).body.data;
    expect(detail.lines[0]).toMatchObject({ suggestedQuantity: 10, available: 42, unitPrice: 100, inCatalogue: true });
    expect(JSON.stringify(detail)).not.toContain("Viral fever");
  });

  it("dispensing takes the earliest-expiry batch first, bills it and closes the prescription", async () => {
    const { ph, napa } = await setup();
    await receive(ph, String(napa._id));
    const { visitId, patient } = await prescription(String(napa._id));

    const res = await ph.post("/api/v1/pharmacy/dispenses").send({
      patientId: String(patient._id),
      visitId,
      items: [{ medicineId: String(napa._id), quantity: 15, prescribedIndex: 0 }],
    });
    expect(res.status).toBe(201);
    // 12 from SOON01 (৳1.00) + 3 from LATE01 (৳1.20)
    expect(res.body.data.items[0].batches).toEqual([
      { batchNo: "SOON01", expiryDate: addDays(today, 60), quantity: 12 },
      { batchNo: "LATE01", expiryDate: addDays(today, 400), quantity: 3 },
    ]);
    expect(res.body.data.total).toBe(12 * 100 + 3 * 120);

    await drainEvents();
    const invoice = await InvoiceModel.findOne({ "origin.type": "dispense" }).lean();
    expect(invoice).toMatchObject({ total: 1560, status: "issued" });
    expect(invoice?.items).toHaveLength(2); // one line per batch price

    const queue = (await ph.get("/api/v1/pharmacy/prescriptions?status=all")).body.data;
    expect(queue[0].status).toBe("dispensed");
    expect(await AuditLogModel.exists({ entityType: "Dispense", action: "CREATE" })).toBeTruthy();
  });

  it("refuses to dispense more than is in stock (nothing changes) and never sells expired batches", async () => {
    const { ph, napa } = await setup();
    await receive(ph, String(napa._id));
    const [patient] = await createPatients(1);
    await MedicineBatchModel.create({
      medicine: napa._id,
      batchNo: "OLD",
      expiryDate: addDays(today, -1),
      quantity: 500,
      initialQuantity: 500,
      unitCost: 50,
      unitPrice: 70,
      supplier: "Old",
      receivedAt: new Date(),
    });

    const short = await ph
      .post("/api/v1/pharmacy/dispenses")
      .send({ patientId: String(patient._id), items: [{ medicineId: String(napa._id), quantity: 43 }] });
    expect(short.status).toBe(409);
    expect(short.body.error.message).toContain("42 available");
    const left = await MedicineBatchModel.find({ medicine: napa._id }).lean();
    expect(left.reduce((s, b) => s + b.quantity, 0)).toBe(542); // untouched

    const stock = (await ph.get("/api/v1/pharmacy/stock?q=napa")).body.data[0];
    expect(stock).toMatchObject({ inStock: 42, expiredQty: 500 });
    const expiry = (await ph.get("/api/v1/pharmacy/expiry?days=90")).body.data;
    expect(expiry.summary.expired.batches).toBe(1);
    expect(expiry.summary.within90.batches).toBe(1); // SOON01 (60 days)
  });

  it("crossing the reorder level alerts stock managers; adjustments and write-offs need a reason", async () => {
    const { ph, napa } = await setup();
    await receive(ph, String(napa._id));
    const [patient] = await createPatients(1);
    await ph
      .post("/api/v1/pharmacy/dispenses")
      .send({ patientId: String(patient._id), items: [{ medicineId: String(napa._id), quantity: 35 }] });
    await new Promise((r) => setTimeout(r, 200));
    const alert = await OutboxMessageModel.findOne({ toRef: "perm:stock:manage" }).lean();
    expect(alert?.renderedText).toContain("Low stock: Napa 500 mg tablet — 7 left");

    const detail = (await ph.get(`/api/v1/pharmacy/stock/${napa._id}`)).body.data;
    const batch = detail.batches.find((b: { quantity: number }) => b.quantity > 0);
    expect((await ph.post(`/api/v1/pharmacy/batches/${batch.id}/adjust`).send({ change: -1 })).status).toBe(400);
    const adjusted = await ph
      .post(`/api/v1/pharmacy/batches/${batch.id}/adjust`)
      .send({ change: -2, reason: "Two strips damaged" });
    expect(adjusted.status).toBe(200);
    const writeOff = await ph
      .post(`/api/v1/pharmacy/batches/${batch.id}/adjust`)
      .send({ writeOff: true, reason: "Recalled by the manufacturer" });
    expect(writeOff.body.data.batches.find((b: { id: string }) => b.id === batch.id)).toMatchObject({
      quantity: 0,
      writtenOff: true,
    });
    expect(await StockMovementModel.countDocuments({ type: { $in: ["adjust", "write_off"] } })).toBe(2);
  });

  it("only pharmacy staff can dispense or receive stock", async () => {
    const { napa } = await setup();
    const rec = await signIn("rec@test.local");
    expect((await rec.get("/api/v1/pharmacy/prescriptions")).status).toBe(403);
    expect((await rec.post("/api/v1/pharmacy/purchases").send({ supplier: "X", date: today, items: [] })).status).toBe(
      403,
    );
    expect((await rec.get(`/api/v1/pharmacy/stock/${napa._id}`)).status).toBe(403);
  });
});
