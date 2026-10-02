import * as otp from "../../src/modules/assistant/otp.service";
import { AppointmentModel } from "../../src/modules/hospital/appointment/appointment.model";
import { PatientModel } from "../../src/modules/patients/patient.model";
import { UserModel } from "../../src/modules/users/user.model";
import { addDays, todayInDhaka } from "../../src/utils/date";
import { createAppointment, createClinic, createPatients } from "../fixtures";
import { app, createUser, request, signIn, useTestDatabase } from "../helpers";

describe("Patient portal", () => {
  useTestDatabase();

  let lastCode = "";
  beforeEach(() => {
    // Capture the code instead of sending it
    jest.spyOn(otp, "deliverCode").mockImplementation(async (_phone, code) => {
      lastCode = code;
      return "whatsapp";
    });
  });
  afterEach(() => jest.restoreAllMocks());

  const FAMILY_PHONE = "+8801711000111";

  /** Mother and child share a phone; a stranger has another number */
  const family = async () => {
    const [mother, child, stranger] = await createPatients(3);
    await PatientModel.updateMany({ _id: { $in: [mother._id, child._id] } }, { $set: { phone: FAMILY_PHONE } });
    return { mother, child, stranger };
  };

  const portalSignIn = async (phone = "01711-000111") => {
    const agent = request.agent(app);
    const sent = await agent.post("/api/v1/portal/auth/request-code").send({ phone });
    expect(sent.status).toBe(200);
    const res = await agent.post("/api/v1/portal/auth/verify").send({ phone, code: lastCode });
    expect(res.status).toBe(200);
    return agent;
  };

  it("signs in with the registered phone and a code; unknown numbers and wrong codes are refused", async () => {
    await family();
    expect((await request(app).post("/api/v1/portal/auth/request-code").send({ phone: "01999999999" })).status).toBe(
      404,
    );

    const agent = request.agent(app);
    await agent.post("/api/v1/portal/auth/request-code").send({ phone: "01711000111" });
    const wrong = await agent
      .post("/api/v1/portal/auth/verify")
      .send({ phone: "01711000111", code: lastCode === "000000" ? "111111" : "000000" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.message).toContain("attempt(s) left");

    const ok = await agent.post("/api/v1/portal/auth/verify").send({ phone: "01711000111", code: lastCode });
    expect(ok.status).toBe(200);
    expect(ok.body.data.user).toMatchObject({ role: "patient" });
    expect(await UserModel.countDocuments({ role: "patient", phone: FAMILY_PHONE })).toBe(1);

    // The same code cannot be used twice
    expect((await agent.post("/api/v1/portal/auth/verify").send({ phone: "01711000111", code: lastCode })).status).toBe(
      400,
    );
  });

  it("a family sees every patient on its phone — and nothing of anyone else", async () => {
    const { mother, child, stranger } = await family();
    const agent = await portalSignIn();
    const me = (await agent.get("/api/v1/portal/me")).body.data;
    expect(me.patients.map((p: { id: string }) => p.id).sort()).toEqual([String(mother._id), String(child._id)].sort());

    const { doctor } = await createClinic();
    await createAppointment({ patient: child, doctor, status: "booked", date: addDays(todayInDhaka(), 2) });
    const strangers = await createAppointment({
      patient: stranger,
      doctor,
      status: "booked",
      date: addDays(todayInDhaka(), 2),
      serialNo: 2,
      slotTime: "09:10",
    });

    const list = (await agent.get("/api/v1/portal/appointments")).body.data;
    expect(list.upcoming).toHaveLength(1);
    expect(list.upcoming[0]).toMatchObject({ patient: { id: String(child._id) }, canCancel: true });

    // Someone else's appointment: 404, never 403 (does not confirm it exists)
    expect(
      (await agent.post(`/api/v1/portal/appointments/${strangers._id}/cancel`).send({ reason: "test" })).status,
    ).toBe(404);
  });

  it("books for an own patient (source portal) and cancels it; booking for a stranger is refused", async () => {
    const { mother, stranger } = await family();
    const { doctor } = await createClinic();
    const agent = await portalSignIn();
    const date = addDays(todayInDhaka(), 1);

    const slots = (await agent.get(`/api/v1/portal/doctors/${doctor._id}/slots?date=${date}`)).body.data;
    expect(slots.slots[0]).toMatchObject({ time: "09:00" });

    const booked = await agent
      .post("/api/v1/portal/appointments")
      .send({ patientId: String(mother._id), doctorId: String(doctor._id), date, slotTime: "09:00" });
    expect(booked.status).toBe(201);
    expect((await AppointmentModel.findById(booked.body.data.id).lean())?.source).toBe("portal");

    const forStranger = await agent
      .post("/api/v1/portal/appointments")
      .send({ patientId: String(stranger._id), doctorId: String(doctor._id), date, slotTime: "09:10" });
    expect(forStranger.status).toBe(404);

    const cancelled = await agent
      .post(`/api/v1/portal/appointments/${booked.body.data.id}/cancel`)
      .send({ reason: "Feeling better" });
    expect(cancelled.status).toBe(200);
    expect((await AppointmentModel.findById(booked.body.data.id).lean())?.status).toBe("cancelled");
  });

  it("prescriptions list only the family's signed visits; another patient's PDF is 404", async () => {
    const { mother, stranger } = await family();
    const doctorUser = await createUser({ role: "doctor", email: "doc@test.local" });
    const { doctor } = await createClinic({ userId: doctorUser._id });
    const doc = await signIn("doc@test.local");
    const close = async (patient: { _id: unknown }, serialNo: number) => {
      const appt = await createAppointment({
        patient,
        doctor,
        status: "checked_in",
        serialNo,
        slotTime: `09:${String(serialNo * 10).padStart(2, "0")}`,
      });
      const visitId = (await doc.post(`/api/v1/appointments/${appt._id}/visit`)).body.data.id as string;
      await doc.patch(`/api/v1/visits/${visitId}`).send({
        provisionalDiagnosis: "Viral fever",
        prescription: [{ brandName: "Napa", genericName: "Paracetamol", dosePattern: "1+1+1", durationDays: 5 }],
      });
      await doc.post(`/api/v1/visits/${visitId}/close`);
      return visitId;
    };
    const own = await close(mother, 1);
    const other = await close(stranger, 2);

    const agent = await portalSignIn();
    const list = (await agent.get("/api/v1/portal/prescriptions")).body.data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: own, medicines: [{ brandName: "Napa", dosePattern: "1+1+1" }] });
    expect((await agent.get(`/api/v1/portal/prescriptions/${other}/pdf`)).status).toBe(404);
  });

  it("staff accounts cannot use the portal, and patients cannot use staff APIs", async () => {
    await family();
    await createUser({ role: "reception", email: "rec@test.local" });
    const rec = await signIn("rec@test.local");
    expect((await rec.get("/api/v1/portal/me")).status).toBe(403);

    const agent = await portalSignIn();
    expect((await agent.get("/api/v1/patients")).status).toBe(403);
    expect((await agent.get("/api/v1/invoices")).status).toBe(403);
  });
});
