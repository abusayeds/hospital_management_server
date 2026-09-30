import { AppointmentModel } from "../../src/modules/hospital/appointment/appointment.model";
import { maskName } from "../../src/modules/hospital/queue/display.service";
import { compareQueue } from "../../src/modules/hospital/queue/queue.service";
import { PatientModel } from "../../src/modules/patients/patient.model";
import { todayInDhaka, weekdayOf } from "../../src/utils/date";
import { createClinic, createPatients } from "../fixtures";
import { app, createUser, request, signIn, useTestDatabase } from "../helpers";

const DISPLAY_KEY = "test-display-key-123"; // tests/setup/test-env.ts

describe("queue ordering (pure)", () => {
  it("in consultation first, then emergency > elderly > normal, then serial", () => {
    const rows = [
      { id: "a", status: "checked_in", priority: "normal" as const, serialNo: 1 },
      { id: "b", status: "checked_in", priority: "elderly" as const, serialNo: 5 },
      { id: "c", status: "in_consultation", priority: "normal" as const, serialNo: 9 },
      { id: "d", status: "checked_in", priority: "emergency" as const, serialNo: 7 },
      { id: "e", status: "checked_in", priority: "normal" as const, serialNo: 2 },
    ];
    expect([...rows].sort(compareQueue).map((r) => r.id)).toEqual(["c", "d", "b", "a", "e"]);
  });

  it("masks names for the public screen", () => {
    expect(maskName("Rahim Hossain")).toBe("R*** H***");
    expect(maskName("  fatema  ")).toBe("F***");
  });
});

describe("Queue API", () => {
  useTestDatabase();

  /** A doctor linked to a login, sitting all day today, with 4 patients in various states */
  const setup = async () => {
    const doctorUser = await createUser({ role: "doctor", email: "doc@test.local" });
    const { doctor } = await createClinic({ userId: doctorUser._id });
    doctor.sessions = [
      { dayOfWeek: weekdayOf(todayInDhaka()), startTime: "00:00", endTime: "23:50", slotMinutes: 10, maxPatients: 150 },
    ];
    await doctor.save();
    const patients = await createPatients(4);
    const date = todayInDhaka();
    const make = (i: number, status: string, priority = "normal") =>
      AppointmentModel.create({
        patient: patients[i]._id,
        doctor: doctor._id,
        department: doctor.department,
        date,
        slotTime: `0${i}:00`,
        sessionKey: "00:00-23:50",
        serialNo: i + 1,
        feeSnapshot: 70000,
        status,
        priority,
        holdsSlot: true,
        statusHistory: [{ status: "booked", at: new Date() }],
      });
    const [s1, s2, s3, s4] = [
      await make(0, "in_consultation"),
      await make(1, "checked_in"),
      await make(2, "checked_in", "elderly"),
      await make(3, "booked"),
    ];
    return { doctor, patients, serial: { s1, s2, s3, s4 } };
  };

  it("doctor sees own ordered queue with estimated waits; call next completes current and calls the next by priority", async () => {
    const { doctor, serial, patients } = await setup();
    const agent = await signIn("doc@test.local");

    const q = (await agent.get("/api/v1/queue/today")).body.data;
    expect(q.current.serialNo).toBe(1);
    expect(q.waiting.map((a: { serialNo: number }) => a.serialNo)).toEqual([3, 2]); // elderly before normal
    expect(q.waiting.map((a: { estimatedWaitMinutes: number }) => a.estimatedWaitMinutes)).toEqual([10, 20]);
    expect(q.notArrived.map((a: { serialNo: number }) => a.serialNo)).toEqual([4]);

    const after = (await agent.post(`/api/v1/queue/${doctor._id}/call-next`)).body.data;
    expect(after.current.serialNo).toBe(3);
    expect(after.stats.completed).toBe(1);

    const done = await AppointmentModel.findById(serial.s1._id);
    expect(done!.status).toBe("completed");
    expect(done!.completedAt).toBeTruthy();
    expect((await PatientModel.findById(patients[0]._id))!.lastVisitDate).toBe(todayInDhaka());
  });

  it("call specific, send back and recall", async () => {
    const { doctor, serial } = await setup();
    const agent = await signIn("doc@test.local");

    const called = (await agent.post(`/api/v1/queue/${doctor._id}/call/${serial.s2._id}`)).body.data;
    expect(called.current.serialNo).toBe(2);

    const back = (await agent.post(`/api/v1/appointments/${serial.s2._id}/send-back`)).body.data;
    expect(back.current).toBeNull();
    expect(back.waiting.map((a: { serialNo: number }) => a.serialNo)).toEqual([3, 2]);

    expect((await agent.post(`/api/v1/queue/${doctor._id}/recall`)).status).toBe(409); // nobody with the doctor now
    await agent.post(`/api/v1/queue/${doctor._id}/call-next`);
    expect((await agent.post(`/api/v1/queue/${doctor._id}/recall`)).status).toBe(200);
  });

  it("reception can see and recall but cannot call next", async () => {
    const { doctor } = await setup();
    await createUser({ role: "reception", email: "rec@test.local" });
    const rec = await signIn("rec@test.local");
    expect((await rec.get(`/api/v1/queue/today?doctorId=${doctor._id}`)).status).toBe(200);
    expect((await rec.post(`/api/v1/queue/${doctor._id}/call-next`)).status).toBe(403);
    expect((await rec.post(`/api/v1/queue/${doctor._id}/recall`)).status).toBe(200);
  });

  it("a doctor cannot see or run another doctor's queue", async () => {
    await setup();
    const { doctor: other } = await createClinic({ departmentName: "ENT", doctorName: "Other" });
    const agent = await signIn("doc@test.local");
    expect((await agent.get(`/api/v1/queue/today?doctorId=${other._id}`)).status).toBe(403);
    expect((await agent.post(`/api/v1/queue/${other._id}/call-next`)).status).toBe(403);
  });

  it("the TV display needs the key and never returns phone numbers, full names or patient codes", async () => {
    const { patients } = await setup();
    expect((await request(app).get("/api/v1/display/queue")).status).toBe(401);
    expect((await request(app).get("/api/v1/display/queue?key=wrong")).status).toBe(401);

    const res = await request(app).get(`/api/v1/display/queue?key=${DISPLAY_KEY}`);
    expect(res.status).toBe(200);
    const card = res.body.data.doctors[0];
    expect(card.nowServing).toEqual({ serialNo: 1, maskedName: maskName(patients[0].name) });
    expect(card.next.map((n: { serialNo: number }) => n.serialNo)).toEqual([3, 2]);

    const text = JSON.stringify(res.body);
    for (const p of patients) {
      expect(text).not.toContain(p.phone);
      expect(text).not.toContain(p.name);
      expect(text).not.toContain(p.patientCode);
    }
  });
});
