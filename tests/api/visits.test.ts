import { drainEvents } from "../../src/events/bus";
import { DomainEventModel } from "../../src/events/domainEvent.model";
import { AuditLogModel } from "../../src/modules/audit/auditLog.model";
import { AppointmentModel } from "../../src/modules/hospital/appointment/appointment.model";
import { PatientModel } from "../../src/modules/patients/patient.model";
import { addDays, todayInDhaka } from "../../src/utils/date";
import { createAppointment, createClinic, createPatients } from "../fixtures";
import { createUser, signIn, useTestDatabase } from "../helpers";

describe("Visits / EMR", () => {
  useTestDatabase();

  const setup = async () => {
    const doctorUser = await createUser({ role: "doctor", email: "doc@test.local" });
    const { doctor } = await createClinic({ userId: doctorUser._id });
    const [patient] = await createPatients(1);
    await PatientModel.updateOne({ _id: patient._id }, { $set: { allergies: ["Penicillin"] } });
    const appt = await createAppointment({ patient, doctor, status: "checked_in" });
    const doc = await signIn("doc@test.local");
    return { doc, doctor, patient, appt };
  };

  const openVisit = async () => {
    const s = await setup();
    const res = await s.doc.post(`/api/v1/appointments/${s.appt._id}/visit`);
    expect(res.status).toBe(201);
    return { ...s, visitId: res.body.data.id as string };
  };

  const napa = { brandName: "Napa", genericName: "Paracetamol", strength: "500 mg", dosePattern: "1+1+1" };

  it("starting a visit moves the patient into consultation, and is idempotent", async () => {
    const { doc, appt } = await setup();
    const first = await doc.post(`/api/v1/appointments/${appt._id}/visit`);
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({ status: "open", patient: { allergies: ["Penicillin"] } });
    expect((await AppointmentModel.findById(appt._id))?.status).toBe("in_consultation");

    const again = await doc.post(`/api/v1/appointments/${appt._id}/visit`);
    expect(again.body.data.id).toBe(first.body.data.id);
  });

  it("builds Bangla instructions from the dose pattern and warns about duplicate generics", async () => {
    const { doc, visitId } = await openVisit();
    const res = await doc.patch(`/api/v1/visits/${visitId}`).send({
      chiefComplaints: ["Fever 3 days"],
      prescription: [
        { ...napa, timing: "after_meal", durationDays: 5 },
        { brandName: "Ace", genericName: "Paracetamol", dosePattern: "0+0+1", durationDays: "continue" },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.visit.prescription[0].instructionsBn).toBe(
      "সকালে ১টা, দুপুরে ১টা, রাতে ১টা — খাবারের পরে — ৫ দিন",
    );
    expect(res.body.data.visit.prescription[1].durationDays).toBe("continue");
    expect(res.body.data.warnings.duplicateGenerics).toEqual(["paracetamol"]);
    expect(await AuditLogModel.countDocuments({ entityType: "Visit", action: "UPDATE" })).toBe(1);
  });

  it("an allergy match is refused unless the doctor overrides it with a reason (audited)", async () => {
    const { doc, visitId } = await openVisit();
    const amoxil = { brandName: "Moxacil", genericName: "Amoxicillin", dosePattern: "1+1+1", durationDays: 7 };

    const refused = await doc.patch(`/api/v1/visits/${visitId}`).send({ prescription: [amoxil] });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("ALLERGY_CONFLICT");

    const allowed = await doc.patch(`/api/v1/visits/${visitId}`).send({
      prescription: [amoxil],
      allergyOverrides: [
        { medicine: "Moxacil", allergy: "Penicillin", reason: "Tolerated before, skin test negative" },
      ],
    });
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.visit.allergyOverrides).toHaveLength(1);
    const audit = await AuditLogModel.findOne({ entityType: "Visit", "meta.allergyOverride": { $exists: true } });
    expect(audit?.meta).toMatchObject({ allergyOverride: { allergy: "Penicillin" } });
  });

  it("closing needs a diagnosis, completes the appointment and emits visit.closed with the follow-up date", async () => {
    const { doc, visitId, appt } = await openVisit();
    expect((await doc.post(`/api/v1/visits/${visitId}/close`)).status).toBe(400);

    const followUp = addDays(todayInDhaka(), 7);
    await doc
      .patch(`/api/v1/visits/${visitId}`)
      .send({ provisionalDiagnosis: "Viral fever", followUp: { date: followUp } });
    const closed = await doc.post(`/api/v1/visits/${visitId}/close`);
    expect(closed.status).toBe(200);
    expect(closed.body.data).toMatchObject({ status: "closed", prescriptionNo: expect.stringMatching(/^RX-/) });
    expect((await AppointmentModel.findById(appt._id))?.status).toBe("completed");

    await drainEvents();
    const event = await DomainEventModel.findOne({ name: "visit.closed" });
    expect(event?.payload).toMatchObject({ visitId, followUpDate: followUp });
    const completed = await DomainEventModel.findOne({ name: "appointment.completed" });
    expect(completed?.payload).toMatchObject({ visitId });
  });

  it("a closed visit is read-only; corrections are addenda with a reason (audited)", async () => {
    const { doc, visitId } = await openVisit();
    await doc.patch(`/api/v1/visits/${visitId}`).send({ provisionalDiagnosis: "Viral fever" });
    await doc.post(`/api/v1/visits/${visitId}/close`);

    const edit = await doc.patch(`/api/v1/visits/${visitId}`).send({ provisionalDiagnosis: "Dengue" });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe("VISIT_CLOSED");

    const add = await doc
      .post(`/api/v1/visits/${visitId}/addenda`)
      .send({ text: "NS1 positive — dengue fever", reason: "Lab result arrived after the visit" });
    expect(add.status).toBe(201);
    expect(add.body.data.provisionalDiagnosis).toBe("Viral fever");
    expect(add.body.data.addenda[0]).toMatchObject({ reason: "Lab result arrived after the visit" });
    expect(await AuditLogModel.countDocuments({ entityType: "VisitAddendum", action: "CREATE" })).toBe(1);
  });

  it("a doctor without an appointment with the patient cannot open the EMR (403, audited)", async () => {
    const { patient, visitId } = await openVisit();
    const other = await createUser({ role: "doctor", email: "other@test.local" });
    await createClinic({ userId: other._id, departmentName: "ENT", doctorName: "Other Doctor" });
    const stranger = await signIn("other@test.local");

    expect((await stranger.get(`/api/v1/patients/${patient._id}/emr`)).status).toBe(403);
    expect((await stranger.get(`/api/v1/visits/${visitId}`)).status).toBe(403);
    expect(await AuditLogModel.countDocuments({ action: "PERMISSION_DENIED" })).toBe(2);
  });

  it("the patient's own doctor can read the history, and each read is a VIEW audit entry", async () => {
    const { doc, patient, visitId } = await openVisit();
    const res = await doc.get(`/api/v1/patients/${patient._id}/emr`);
    expect(res.status).toBe(200);
    expect(res.body.data.visits[0]).toMatchObject({ id: visitId, status: "open" });
    await doc.get(`/api/v1/visits/${visitId}`);
    expect(await AuditLogModel.countDocuments({ action: "VIEW", entityType: "Patient" })).toBe(1);
    expect(await AuditLogModel.countDocuments({ action: "VIEW", entityType: "Visit" })).toBe(1);
  });

  it("call next is blocked while the current patient's visit is open", async () => {
    const { doc, doctor, visitId } = await openVisit();
    const [second] = await createPatients(1);
    await createAppointment({ patient: second, doctor, status: "checked_in", slotTime: "09:10", serialNo: 2 });

    const blocked = await doc.post(`/api/v1/queue/${doctor._id}/call-next`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("VISIT_OPEN");

    await doc.patch(`/api/v1/visits/${visitId}`).send({ provisionalDiagnosis: "URTI" });
    await doc.post(`/api/v1/visits/${visitId}/close`);
    expect((await doc.post(`/api/v1/queue/${doctor._id}/call-next`)).status).toBe(200);
  });

  it("prescription templates are private to the doctor who made them", async () => {
    const { doc } = await setup();
    const created = await doc
      .post("/api/v1/visits/templates")
      .send({ name: "Adult fever", diagnosis: "Viral fever", items: [{ ...napa, durationDays: 3 }] });
    expect(created.status).toBe(201);

    const other = await createUser({ role: "doctor", email: "other@test.local" });
    await createClinic({ userId: other._id, departmentName: "ENT", doctorName: "Other Doctor" });
    const stranger = await signIn("other@test.local");
    expect((await stranger.get("/api/v1/visits/templates")).body.data).toEqual([]);
    expect((await stranger.delete(`/api/v1/visits/templates/${created.body.data.id}`)).status).toBe(404);
  });
});
