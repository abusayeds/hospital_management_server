import { computeDaySlots, ScheduleSession, sessionKeyOf, slotTimesOf, validateSessions } from "../../src/modules/hospital/scheduling/slotEngine";

// 2026-10-03 is a Saturday (dayOfWeek 6)
const SAT = "2026-10-03";
const morning: ScheduleSession = { dayOfWeek: 6, startTime: "09:00", endTime: "10:00", slotMinutes: 15, maxPatients: 10 };
const evening: ScheduleSession = { dayOfWeek: 6, startTime: "17:00", endTime: "18:00", slotMinutes: 20, maxPatients: 2 };
const mondayOnly: ScheduleSession = { dayOfWeek: 1, startTime: "09:00", endTime: "12:00", slotMinutes: 10, maxPatients: 10 };

describe("slot engine", () => {
  it("builds slots per session; the last slot must end by the session end", () => {
    expect(slotTimesOf(morning)).toEqual(["09:00", "09:15", "09:30", "09:45"]);
    expect(slotTimesOf({ ...morning, endTime: "09:50" })).toEqual(["09:00", "09:15", "09:30"]);
  });

  it("supports several sessions a day, ordered by time, each with its own label", () => {
    const day = computeDaySlots({ date: SAT, sessions: [evening, morning, mondayOnly], leaves: [], bookings: [] });
    expect(day.sessions.map((s) => s.label)).toEqual(["Morning", "Evening"]);
    expect(day.slots.map((s) => s.time)).toEqual(["09:00", "09:15", "09:30", "09:45", "17:00", "17:20", "17:40"]);
    expect(day.nextAvailable?.time).toBe("09:00");
  });

  it("returns nothing on a day without sessions", () => {
    const day = computeDaySlots({ date: SAT, sessions: [mondayOnly], leaves: [], bookings: [] });
    expect(day.slots).toHaveLength(0);
    expect(day.nextAvailable).toBeNull();
  });

  it("returns nothing on a leave day and says why", () => {
    const day = computeDaySlots({
      date: SAT,
      sessions: [morning],
      leaves: [{ from: "2026-10-01", to: "2026-10-05", reason: "Conference" }],
      bookings: [],
    });
    expect(day).toMatchObject({ onLeave: true, leaveReason: "Conference", availableCount: 0 });
    expect(day.slots).toHaveLength(0);
  });

  it("marks booked slots unavailable", () => {
    const day = computeDaySlots({
      date: SAT,
      sessions: [morning],
      leaves: [],
      bookings: [{ slotTime: "09:00", sessionKey: sessionKeyOf(morning) }],
    });
    expect(day.slots[0]).toMatchObject({ time: "09:00", available: false, reason: "booked" });
    expect(day.nextAvailable?.time).toBe("09:15");
  });

  it("hides past times when the date is today (slot at the current minute counts as past)", () => {
    const day = computeDaySlots({ date: SAT, sessions: [morning], leaves: [], bookings: [], nowMinutes: 9 * 60 + 15 });
    expect(day.slots.filter((s) => s.reason === "past").map((s) => s.time)).toEqual(["09:00", "09:15"]);
    expect(day.nextAvailable?.time).toBe("09:30");
  });

  it("closes a session once maxPatients is reached, even if times are left", () => {
    const key = sessionKeyOf(evening);
    const day = computeDaySlots({
      date: SAT,
      sessions: [evening],
      leaves: [],
      bookings: [
        { slotTime: "17:00", sessionKey: key },
        { slotTime: "17:20", sessionKey: key },
      ],
    });
    expect(day.sessions[0]).toMatchObject({ capacity: 2, booked: 2, remaining: 0, isFull: true });
    expect(day.slots[2]).toMatchObject({ time: "17:40", available: false, reason: "session_full" });
    expect(day.availableCount).toBe(0);
  });

  it("validates schedules: end after start, at least one slot, no overlaps", () => {
    expect(validateSessions([morning, evening])).toEqual([]);
    expect(validateSessions([{ ...morning, endTime: "08:00" }])[0]).toMatch(/end time must be after start/);
    expect(validateSessions([{ ...morning, endTime: "09:10" }])[0]).toMatch(/shorter than one slot/);
    expect(validateSessions([morning, { ...morning, startTime: "09:30", endTime: "11:00" }])[0]).toMatch(/overlaps/);
  });
});
