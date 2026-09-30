import { drainEvents, publish, resetSubscriptions, subscribe } from "../../src/events/bus";
import { DomainEventModel, IDomainEvent } from "../../src/events/domainEvent.model";
import { appointmentService } from "../../src/modules/hospital/appointment/appointment.service";
import { todayInDhaka, weekdayOf } from "../../src/utils/date";
import { createClinic, createPatients, TOMORROW } from "../fixtures";
import { useTestDatabase } from "../helpers";

describe("Domain event bus", () => {
  useTestDatabase();
  afterEach(() => resetSubscriptions());

  it("persists every event with a status per consumer", async () => {
    const seen: string[] = [];
    subscribe("lab.sample_collected", "test-consumer", (e) => {
      seen.push(e.payload.labOrderId);
    });
    await publish("lab.sample_collected", { labOrderId: "L1", patientId: "P1" });
    await drainEvents();

    expect(seen).toEqual(["L1"]);
    const stored = await DomainEventModel.findOne({ name: "lab.sample_collected" }).lean<IDomainEvent>();
    expect(stored!.payload).toEqual({ labOrderId: "L1", patientId: "P1" });
    expect(stored!.consumers).toEqual([expect.objectContaining({ name: "test-consumer", status: "done" })]);
  });

  it("a failing handler is recorded as failed and never breaks publish or other handlers", async () => {
    const ran: string[] = [];
    subscribe("lab.report_ready", "broken", () => {
      throw new Error("boom");
    });
    subscribe("lab.report_ready", "healthy", () => {
      ran.push("healthy");
    });

    await expect(
      publish("lab.report_ready", { labOrderId: "L2", patientId: "P2", doctorId: null, visitId: null }),
    ).resolves.toBeUndefined();
    await drainEvents();

    expect(ran).toEqual(["healthy"]);
    const stored = await DomainEventModel.findOne({ name: "lab.report_ready" }).lean<IDomainEvent>();
    const byName = Object.fromEntries(stored!.consumers.map((c) => [c.name, c]));
    expect(byName.broken).toMatchObject({ status: "failed", error: "boom" });
    expect(byName.healthy).toMatchObject({ status: "done" });
  });

  it("appointment flows publish booked, checked_in and rescheduled (ids only)", async () => {
    const { doctor } = await createClinic();
    const today = todayInDhaka();
    doctor.sessions = [
      { dayOfWeek: weekdayOf(today), startTime: "00:00", endTime: "23:50", slotMinutes: 10, maxPatients: 150 },
      { dayOfWeek: weekdayOf(TOMORROW()), startTime: "09:00", endTime: "12:00", slotMinutes: 10, maxPatients: 18 },
    ];
    await doctor.save();
    const [p1, p2] = await createPatients(2);

    const a1 = await appointmentService.bookAppointment({
      patientId: String(p1._id),
      doctorId: String(doctor._id),
      date: today,
      source: "reception",
    });
    await appointmentService.checkIn(a1.id, {});
    const a2 = await appointmentService.bookAppointment({
      patientId: String(p2._id),
      doctorId: String(doctor._id),
      date: TOMORROW(),
      source: "reception",
    });
    await appointmentService.rescheduleAppointment(a2.id, { date: TOMORROW(), slotTime: "11:00" }, {});
    await drainEvents();

    const names = (await DomainEventModel.find().sort({ occurredAt: 1 }).lean()).map((e) => e.name);
    expect(names).toEqual([
      "appointment.booked",
      "appointment.checked_in",
      "appointment.booked",
      "appointment.rescheduled",
    ]);
    // a reschedule is ONE event, not cancelled + booked
    expect(names).not.toContain("appointment.cancelled");

    const checkedIn = await DomainEventModel.findOne({ name: "appointment.checked_in" }).lean<IDomainEvent>();
    expect(Object.keys(checkedIn!.payload).sort()).toEqual(["appointmentId", "date", "doctorId", "patientId"]);
    expect(JSON.stringify(checkedIn!.payload)).not.toMatch(/Patient \d/); // no names in payloads
  });
});
