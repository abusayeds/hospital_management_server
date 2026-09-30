import { AuditLogModel } from "../../src/modules/audit/auditLog.model";
import { AppointmentModel } from "../../src/modules/hospital/appointment/appointment.model";
import { bookAppointment } from "../../src/modules/hospital/appointment/appointment.service";
import { addDays, todayInDhaka } from "../../src/utils/date";
import { createClinic, createPatients, TOMORROW } from "../fixtures";
import { createUser, signIn, useTestDatabase } from "../helpers";

describe("Booking service", () => {
  useTestDatabase();

  const receptionAgent = async () => {
    await createUser({ role: "reception", email: "reception@test.local" });
    return signIn("reception@test.local");
  };

  it("10 parallel bookings for the SAME slot: exactly one succeeds, nine get a friendly 409", async () => {
    const { doctor } = await createClinic();
    const patients = await createPatients(10);
    const agent = await receptionAgent();
    const date = TOMORROW();

    const results = await Promise.all(
      patients.map((p) =>
        agent
          .post("/api/v1/appointments")
          .send({ patientId: String(p._id), doctorId: String(doctor._id), date, slotTime: "09:30" }),
      ),
    );

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 409);
    expect(rejected).toHaveLength(9);
    for (const r of rejected) {
      expect(r.body.error.code).toBe("CONFLICT");
      expect(r.body.error.details.nextSlots.length).toBeGreaterThan(0); // offers alternatives
      expect(r.body.error.details.nextSlots).not.toContain("09:30");
    }
    expect(
      await AppointmentModel.countDocuments({ doctor: doctor._id, date, slotTime: "09:30", holdsSlot: true }),
    ).toBe(1);
  });

  it("serial numbers stay unique and sequential when 12 different slots are booked at once", async () => {
    const { doctor } = await createClinic();
    const patients = await createPatients(12);
    const date = TOMORROW();
    const times = [
      "09:00",
      "09:10",
      "09:20",
      "09:30",
      "09:40",
      "09:50",
      "10:00",
      "10:10",
      "10:20",
      "10:30",
      "10:40",
      "10:50",
    ];

    const booked = await Promise.all(
      patients.map((p, i) =>
        bookAppointment({
          patientId: String(p._id),
          doctorId: String(doctor._id),
          date,
          slotTime: times[i],
          source: "reception",
        }),
      ),
    );
    const serials = booked.map((a) => a.serialNo).sort((a, b) => a - b);
    expect(serials).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  it("without slotTime, books the next free slot; blocks a second active booking for the same patient + doctor + day", async () => {
    const { doctor } = await createClinic();
    const [p1, p2] = await createPatients(2);
    const date = TOMORROW();
    const a = await bookAppointment({
      patientId: String(p1._id),
      doctorId: String(doctor._id),
      date,
      source: "reception",
    });
    const b = await bookAppointment({
      patientId: String(p2._id),
      doctorId: String(doctor._id),
      date,
      source: "reception",
    });
    expect([a.slotTime, b.slotTime]).toEqual(["09:00", "09:10"]);
    await expect(
      bookAppointment({ patientId: String(p1._id), doctorId: String(doctor._id), date, source: "reception" }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("closes a session at maxPatients even when times remain", async () => {
    const { doctor } = await createClinic({ maxPatients: 2 });
    const patients = await createPatients(3);
    const date = TOMORROW();
    for (const p of patients.slice(0, 2))
      await bookAppointment({ patientId: String(p._id), doctorId: String(doctor._id), date, source: "reception" });
    await expect(
      bookAppointment({ patientId: String(patients[2]._id), doctorId: String(doctor._id), date, source: "reception" }),
    ).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("rejects leave days, days outside the booking window and past dates", async () => {
    const { doctor } = await createClinic();
    const [p] = await createPatients(1);
    const date = TOMORROW();
    doctor.leaves.push({ from: date, to: date, reason: "Conference" });
    await doctor.save();
    await expect(
      bookAppointment({ patientId: String(p._id), doctorId: String(doctor._id), date, source: "reception" }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/leave/),
    });
    await expect(
      bookAppointment({
        patientId: String(p._id),
        doctorId: String(doctor._id),
        date: addDays(todayInDhaka(), 60),
        source: "reception",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      bookAppointment({
        patientId: String(p._id),
        doctorId: String(doctor._id),
        date: addDays(todayInDhaka(), -1),
        source: "reception",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("detects a follow-up (same doctor within followUpValidDays) and charges the follow-up fee", async () => {
    const { doctor } = await createClinic({ followUpValidDays: 30 });
    const [p] = await createPatients(1);
    await AppointmentModel.create({
      patient: p._id,
      doctor: doctor._id,
      department: doctor.department,
      date: addDays(todayInDhaka(), -10),
      slotTime: "09:00",
      sessionKey: "09:00-12:00",
      serialNo: 1,
      feeSnapshot: 70000,
      status: "completed",
      holdsSlot: false,
    });
    const a = await bookAppointment({
      patientId: String(p._id),
      doctorId: String(doctor._id),
      date: TOMORROW(),
      source: "reception",
    });
    expect(a).toMatchObject({ type: "follow_up", fee: 35000 });
  });

  it("enforces status transitions, records history and audits every change", async () => {
    const { doctor } = await createClinic();
    const [p] = await createPatients(1);
    const agent = await receptionAgent();
    const created = await agent
      .post("/api/v1/appointments")
      .send({ patientId: String(p._id), doctorId: String(doctor._id), date: TOMORROW() });
    const id = created.body.data.id;

    // Tomorrow's appointment cannot be checked in today
    expect((await agent.post(`/api/v1/appointments/${id}/check-in`).send({})).status).toBe(409);
    // Future appointment cannot be a no-show
    expect((await agent.post(`/api/v1/appointments/${id}/no-show`)).status).toBe(409);

    const cancelled = await agent.post(`/api/v1/appointments/${id}/cancel`).send({ reason: "Patient called" });
    expect(cancelled.body.data).toMatchObject({ status: "cancelled", cancelReason: "Patient called" });
    expect(cancelled.body.data.statusHistory.map((h: { status: string }) => h.status)).toEqual(["booked", "cancelled"]);
    // cancelled → checked in is not allowed
    const again = await agent.post(`/api/v1/appointments/${id}/cancel`).send({ reason: "twice" });
    expect(again.status).toBe(409);

    // The freed slot can be booked again
    const [p2] = await createPatients(1);
    const rebook = await agent
      .post("/api/v1/appointments")
      .send({
        patientId: String(p2._id),
        doctorId: String(doctor._id),
        date: TOMORROW(),
        slotTime: created.body.data.slotTime,
      });
    expect(rebook.status).toBe(201);

    expect(await AuditLogModel.countDocuments({ entityType: "Appointment", entityId: id })).toBe(2); // CREATE + cancel
  });

  it("walk-in books today's next slot and checks in immediately", async () => {
    const { doctor } = await createClinic();
    // Make every hour of today bookable so the test does not depend on the clock
    doctor.sessions = [
      {
        dayOfWeek: new Date(`${todayInDhaka()}T00:00:00Z`).getUTCDay(),
        startTime: "00:00",
        endTime: "23:50",
        slotMinutes: 10,
        maxPatients: 150,
      },
    ];
    await doctor.save();
    const [p] = await createPatients(1);
    const agent = await receptionAgent();
    const res = await agent
      .post("/api/v1/appointments")
      .send({ patientId: String(p._id), doctorId: String(doctor._id), date: todayInDhaka(), source: "walk_in" });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("checked_in");
    expect(res.body.data.statusHistory.map((h: { status: string }) => h.status)).toEqual(["booked", "checked_in"]);
  });

  it("reschedules in one transaction: old appointment cancelled and linked, new one booked", async () => {
    const { doctor } = await createClinic();
    const [p] = await createPatients(1);
    const agent = await receptionAgent();
    const first = (
      await agent
        .post("/api/v1/appointments")
        .send({ patientId: String(p._id), doctorId: String(doctor._id), date: TOMORROW(), slotTime: "09:00" })
    ).body.data;
    const moved = await agent
      .post(`/api/v1/appointments/${first.id}/reschedule`)
      .send({ date: addDays(todayInDhaka(), 2), slotTime: "10:00" });
    expect(moved.status).toBe(200);
    expect(moved.body.data).toMatchObject({
      date: addDays(todayInDhaka(), 2),
      slotTime: "10:00",
      status: "booked",
      rescheduledFrom: first.id,
    });
    const old = (await agent.get(`/api/v1/appointments/${first.id}`)).body.data;
    expect(old).toMatchObject({ status: "cancelled", rescheduledTo: moved.body.data.id });
  });

  it("a doctor only ever sees their own appointments", async () => {
    const doctorUser = await createUser({ role: "doctor", email: "doc@test.local" });
    const { doctor } = await createClinic({ userId: doctorUser._id });
    const { doctor: other } = await createClinic({ departmentName: "Cardiology", doctorName: "Other Doctor" });
    const [p1, p2] = await createPatients(2);
    const mine = await bookAppointment({
      patientId: String(p1._id),
      doctorId: String(doctor._id),
      date: TOMORROW(),
      source: "reception",
    });
    const agent = await signIn("doc@test.local");

    const list = await agent.get(`/api/v1/appointments?date=${TOMORROW()}`);
    expect(list.body.data.map((a: { id: string }) => a.id)).toEqual([mine.id]);

    const theirs = await bookAppointment({
      patientId: String(p2._id),
      doctorId: String(other._id),
      date: TOMORROW(),
      source: "reception",
    });
    expect((await agent.get(`/api/v1/appointments/${theirs.id}`)).status).toBe(403);
    // asking for the other doctor explicitly still returns nothing
    expect((await agent.get(`/api/v1/appointments?doctorId=${other._id}`)).body.data).toEqual([]);
  });
});
