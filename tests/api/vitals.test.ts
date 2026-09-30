import { AuditLogModel } from "../../src/modules/audit/auditLog.model";
import { AppointmentModel } from "../../src/modules/hospital/appointment/appointment.model";
import { createAppointment, createClinic, createPatients } from "../fixtures";
import { createUser, signIn, useTestDatabase } from "../helpers";

describe("Nurse vitals", () => {
  useTestDatabase();

  const setup = async () => {
    await createUser({ role: "nurse", email: "nurse@test.local" });
    const doctorUser = await createUser({ role: "doctor", email: "doc@test.local" });
    const { doctor } = await createClinic({ userId: doctorUser._id });
    const [patient] = await createPatients(1);
    const appt = await createAppointment({ patient, doctor, status: "checked_in" });
    return { nurse: await signIn("nurse@test.local"), doctor, patient, appt };
  };

  it("records vitals, computes BMI and flags, and shows them in the worklist", async () => {
    const { nurse, appt } = await setup();
    const res = await nurse.post(`/api/v1/appointments/${appt._id}/vitals`).send({
      bpSystolic: 150,
      bpDiastolic: 95,
      pulse: 88,
      temperatureF: 98.6,
      spo2: 97,
      weightKg: 70,
      heightCm: 170,
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ bmi: 24.2, flagLevel: "abnormal" });
    expect(res.body.data.flags.map((f: { key: string }) => f.key).sort()).toEqual(["bmi", "bp"]);

    const list = await nurse.get("/api/v1/vitals/worklist");
    expect(list.body.data[0]).toMatchObject({
      appointmentId: String(appt._id),
      vitals: { recorded: true, flagLevel: "abnormal" },
    });
    expect(await AuditLogModel.countDocuments({ entityType: "Vitals", action: "CREATE" })).toBe(1);
  });

  it("rejects impossible values and half-entered BP with clear messages", async () => {
    const { nurse, appt } = await setup();
    const res = await nurse.post(`/api/v1/appointments/${appt._id}/vitals`).send({ bpSystolic: 120, spo2: 140 });
    expect(res.status).toBe(400);
    const paths = res.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(["body.spo2", "body.bpDiastolic"]));
  });

  it("corrections are allowed while waiting, not after the consultation started", async () => {
    const { nurse, appt } = await setup();
    await nurse.post(`/api/v1/appointments/${appt._id}/vitals`).send({ pulse: 70 });
    expect((await nurse.patch(`/api/v1/appointments/${appt._id}/vitals`).send({ pulse: 72 })).status).toBe(200);

    await AppointmentModel.updateOne({ _id: appt._id }, { $set: { status: "in_consultation" } });
    const late = await nurse.patch(`/api/v1/appointments/${appt._id}/vitals`).send({ pulse: 75 });
    expect(late.status).toBe(409);
  });

  it("a patient who is only booked (not checked in) cannot get vitals yet", async () => {
    const { nurse, doctor } = await setup();
    const [other] = await createPatients(1);
    const booked = await createAppointment({
      patient: other,
      doctor,
      status: "booked",
      slotTime: "10:00",
      serialNo: 2,
    });
    expect((await nurse.post(`/api/v1/appointments/${booked._id}/vitals`).send({ pulse: 80 })).status).toBe(409);
  });

  it("a doctor without an appointment with the patient cannot read their vitals history (audited)", async () => {
    const { patient } = await setup();
    const strangerUser = await createUser({ role: "doctor", email: "other@test.local" });
    await createClinic({ userId: strangerUser._id, departmentName: "ENT", doctorName: "Other Doctor" });
    const stranger = await signIn("other@test.local");

    const res = await stranger.get(`/api/v1/patients/${patient._id}/vitals`);
    expect(res.status).toBe(403);
    expect(await AuditLogModel.countDocuments({ action: "PERMISSION_DENIED", entityType: "Patient" })).toBe(1);
  });
});
