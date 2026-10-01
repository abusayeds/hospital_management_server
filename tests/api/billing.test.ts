import { drainEvents } from "../../src/events/bus";
import { DomainEventModel } from "../../src/events/domainEvent.model";
import { AuditLogModel } from "../../src/modules/audit/auditLog.model";
import { InvoiceModel } from "../../src/modules/billing/invoice.model";
import { invoiceForVisit } from "../../src/modules/billing/invoice.service";
import { LabTestModel } from "../../src/modules/hospital/catalog/catalog.models";
import { todayInDhaka } from "../../src/utils/date";
import { createAppointment, createClinic, createPatients } from "../fixtures";
import { createUser, signIn, useTestDatabase } from "../helpers";

describe("Billing", () => {
  useTestDatabase();

  /** Doctor closes a visit → the consultation invoice is created automatically */
  const closedVisit = async (opts: { withCbc?: boolean } = {}) => {
    const doctorUser = await createUser({ role: "doctor", email: "doc@test.local" });
    await createUser({ role: "accounts", email: "acc@test.local" });
    await createUser({ role: "management", email: "mgmt@test.local" });
    const { doctor } = await createClinic({ userId: doctorUser._id });
    const [patient] = await createPatients(1);
    const cbc = opts.withCbc
      ? await LabTestModel.create({
          name: "Complete Blood Count",
          code: "CBC",
          category: "Haematology",
          price: 40000,
          sampleType: "Blood (EDTA)",
          turnaroundHours: 4,
          parameters: [{ name: "Haemoglobin", unit: "g/dL", normalMin: 12, normalMax: 16 }],
        })
      : null;
    const appt = await createAppointment({ patient, doctor, status: "checked_in" });
    const doc = await signIn("doc@test.local");
    const visitId = (await doc.post(`/api/v1/appointments/${appt._id}/visit`)).body.data.id as string;
    await doc.patch(`/api/v1/visits/${visitId}`).send({
      provisionalDiagnosis: "Viral fever",
      ...(cbc && { investigations: [{ labTestId: String(cbc._id), name: cbc.name }] }),
    });
    expect((await doc.post(`/api/v1/visits/${visitId}/close`)).status).toBe(200);
    await drainEvents();
    const acc = await signIn("acc@test.local");
    return { doc, acc, doctor, patient, appt, visitId, cbc };
  };

  const consultationInvoice = async (acc: Awaited<ReturnType<typeof signIn>>, patientId: string) => {
    const list = await acc.get(`/api/v1/invoices?patientId=${patientId}`);
    expect(list.status).toBe(200);
    return list.body.data.find((i: { origin: { type: string } }) => i.origin.type === "visit");
  };

  it("closing a visit creates one issued consultation invoice (idempotent on replay)", async () => {
    const { acc, patient, appt, visitId, doctor } = await closedVisit();
    const inv = await consultationInvoice(acc, String(patient._id));
    expect(inv).toMatchObject({ status: "issued", total: 70000, amountDue: 70000, invoiceNo: expect.any(String) });
    expect(inv.items[0]).toMatchObject({ source: "consultation", unitPrice: 70000 });

    // The event delivered twice must not bill twice
    await invoiceForVisit({
      visitId,
      appointmentId: String(appt._id),
      patientId: String(patient._id),
      doctorId: String(doctor._id),
      date: todayInDhaka(),
    });
    expect(await InvoiceModel.countDocuments({ "origin.type": "visit" })).toBe(1);
    expect(await DomainEventModel.countDocuments({ name: "invoice.issued" })).toBeGreaterThanOrEqual(1);
  });

  it("a verified lab report creates the lab invoice from the catalogue price", async () => {
    const { patient, cbc } = await closedVisit({ withCbc: true });
    await createUser({ role: "lab_technician", email: "lab1@test.local" });
    await createUser({ role: "lab_technician", email: "lab2@test.local" });
    const lab1 = await signIn("lab1@test.local");
    const lab2 = await signIn("lab2@test.local");
    const order = (await lab1.get("/api/v1/lab-orders/board")).body.data[0];
    await lab1.post(`/api/v1/lab-orders/${order.id}/collect`);
    await lab1
      .patch(`/api/v1/lab-orders/${order.id}/results`)
      .send({ tests: [{ labTestId: String(cbc!._id), results: [{ name: "Haemoglobin", value: "13" }] }] });
    await lab1.post(`/api/v1/lab-orders/${order.id}/submit`);
    expect((await lab2.post(`/api/v1/lab-orders/${order.id}/verify`)).status).toBe(200);
    await drainEvents();

    const labInvoice = await InvoiceModel.findOne({ patient: patient._id, "origin.type": "lab_order" }).lean();
    expect(labInvoice).toMatchObject({ total: 40000 });
    expect(labInvoice?.items[0]).toMatchObject({ source: "lab_test", unitPrice: 40000 });
  });

  it("partial then full payment moves issued → partial → paid; overpaying and bKash without a reference are refused", async () => {
    const { acc, patient } = await closedVisit();
    const inv = await consultationInvoice(acc, String(patient._id));

    const bkash = await acc.post(`/api/v1/invoices/${inv.id}/payment`).send({ amount: 20000, method: "bkash" });
    expect(bkash.status).toBe(400);

    const part = await acc.post(`/api/v1/invoices/${inv.id}/payment`).send({ amount: 30000, method: "cash" });
    expect(part.status).toBe(200);
    expect(part.body.data).toMatchObject({ status: "partial", amountPaid: 30000, amountDue: 40000 });

    const over = await acc.post(`/api/v1/invoices/${inv.id}/payment`).send({ amount: 50000, method: "cash" });
    expect(over.status).toBe(409);

    const rest = await acc
      .post(`/api/v1/invoices/${inv.id}/payment`)
      .send({ amount: 40000, method: "bkash", reference: "TRX9AB12" });
    expect(rest.body.data).toMatchObject({ status: "paid", amountDue: 0 });

    await drainEvents();
    expect(await DomainEventModel.countDocuments({ name: "payment.collected" })).toBe(2);

    // Paid invoices cannot be voided; refunds are recorded instead
    expect((await acc.post(`/api/v1/invoices/${inv.id}/void`).send({ reason: "Entered twice" })).status).toBe(409);
    const refund = await acc
      .post(`/api/v1/invoices/${inv.id}/refund`)
      .send({ amount: 10000, method: "cash", reason: "Fee waived by director" });
    expect(refund.status).toBe(200);
    expect(refund.body.data.amountPaid).toBe(60000);
  });

  it("daily collection = payments by method minus refunds; money stays in whole poisha", async () => {
    const { acc, patient } = await closedVisit();
    const inv = await consultationInvoice(acc, String(patient._id));
    await acc.post(`/api/v1/invoices/${inv.id}/payment`).send({ amount: 50000, method: "cash" });
    await acc.post(`/api/v1/invoices/${inv.id}/payment`).send({ amount: 20000, method: "card", reference: "4242" });
    await acc
      .post(`/api/v1/invoices/${inv.id}/refund`)
      .send({ amount: 5000, method: "cash", reason: "Partial waiver" });

    const res = await acc.get(`/api/v1/reports/daily-collection?date=${todayInDhaka()}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ net: 65000, refunds: 5000 });
    expect(res.body.data.byMethod.card.amount).toBe(20000);
    expect((await acc.post(`/api/v1/invoices/${inv.id}/payment`).send({ amount: 10.5, method: "cash" })).status).toBe(
      400,
    );
  });

  it("read-only finance viewers see the patient phone masked; the cash counter sees it", async () => {
    const { acc, patient } = await closedVisit();
    const full = await consultationInvoice(acc, String(patient._id));
    expect(full.patient.phone).toBe(patient.phone);

    const mgmt = await signIn("mgmt@test.local");
    const masked = (await mgmt.get(`/api/v1/invoices/${full.id}`)).body.data;
    expect(masked.patient.phone).not.toBe(patient.phone);
    expect(masked.patient.phone).toMatch(/•+\d{3}$/);
    // …and management cannot take money
    expect((await mgmt.post(`/api/v1/invoices/${full.id}/payment`).send({ amount: 1000, method: "cash" })).status).toBe(
      403,
    );
  });

  it("receipts are PDFs and their download is audited", async () => {
    const { acc, patient } = await closedVisit();
    const inv = await consultationInvoice(acc, String(patient._id));
    const pdf = await acc.get(`/api/v1/invoices/${inv.id}/receipt.pdf`).buffer(true);
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    expect(
      await AuditLogModel.countDocuments({ action: "VIEW", entityType: "Invoice", "meta.output": "receipt_pdf" }),
    ).toBe(1);
  }, 60_000);
});
