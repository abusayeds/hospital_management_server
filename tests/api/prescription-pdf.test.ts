import { closePdfBrowser } from "../../src/documents/pdf";
import { signDocumentCode, verifyDocumentCode } from "../../src/documents/signing";
import { AuditLogModel } from "../../src/modules/audit/auditLog.model";
import { createAppointment, createClinic, createPatients } from "../fixtures";
import { createUser, request, app, signIn, useTestDatabase } from "../helpers";

describe("Signed document codes", () => {
  it("verifies a genuine code and rejects a tampered one", () => {
    const code = signDocumentCode("RX-000042");
    expect(verifyDocumentCode(code)).toBe("RX-000042");
    expect(verifyDocumentCode(code.replace("RX-000042", "RX-000043"))).toBeNull();
    expect(verifyDocumentCode("RX-000042.forged")).toBeNull();
    expect(verifyDocumentCode("nonsense")).toBeNull();
  });
});

describe("Prescription PDF and public verification", () => {
  useTestDatabase();
  afterAll(() => closePdfBrowser());

  const closedVisit = async () => {
    const doctorUser = await createUser({ role: "doctor", email: "doc@test.local" });
    const { doctor } = await createClinic({ userId: doctorUser._id });
    const [patient] = await createPatients(1);
    const appt = await createAppointment({ patient, doctor, status: "checked_in" });
    const doc = await signIn("doc@test.local");
    const visitId = (await doc.post(`/api/v1/appointments/${appt._id}/visit`)).body.data.id as string;
    await doc.patch(`/api/v1/visits/${visitId}`).send({
      provisionalDiagnosis: "Viral fever",
      prescription: [
        { brandName: "Napa", genericName: "Paracetamol", dosePattern: "1+1+1", timing: "after_meal", durationDays: 5 },
      ],
    });
    return { doc, visitId, patient };
  };

  it("an open visit cannot be printed", async () => {
    const { doc, visitId } = await closedVisit();
    expect((await doc.get(`/api/v1/visits/${visitId}/prescription.pdf`)).status).toBe(409);
  });

  it("prints a closed visit as a PDF (audited) and the QR code verifies publicly without identifiers", async () => {
    const { doc, visitId, patient } = await closedVisit();
    const closed = await doc.post(`/api/v1/visits/${visitId}/close`);
    const rxNo = closed.body.data.prescriptionNo as string;

    const pdf = await doc.get(`/api/v1/visits/${visitId}/prescription.pdf`).buffer(true);
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.headers["cache-control"]).toBe("no-store");
    expect(Buffer.from(pdf.body).subarray(0, 4).toString()).toBe("%PDF");
    expect(await AuditLogModel.countDocuments({ action: "VIEW", "meta.output": "prescription_pdf" })).toBe(1);

    const ok = await request(app).get(`/api/v1/public/verify/${encodeURIComponent(signDocumentCode(rxNo))}`);
    expect(ok.body.data).toMatchObject({ valid: true, type: "prescription", number: rxNo, corrections: 0 });
    expect(ok.body.data.patient).toMatch(/^P\*+ /); // "Patient 7" → "P****** 7**"
    expect(JSON.stringify(ok.body)).not.toContain(patient.phone);
    expect(JSON.stringify(ok.body)).not.toContain("Viral fever");

    const forged = await request(app).get(`/api/v1/public/verify/${rxNo}.AAAAAAAAAAAA`);
    expect(forged.body.data).toEqual({ valid: false });
  }, 60_000);
});
