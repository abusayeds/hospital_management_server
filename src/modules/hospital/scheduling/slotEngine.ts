import { sessionLabel, toHHMM, toMinutes, weekdayOf } from "../../../utils/date";

/**
 * SLOT ENGINE — a PURE function: no database, no clock, no randomness.
 * Everything it needs (schedule, leaves, bookings, "now") is passed in, so the
 * same input always gives the same answer and every rule is easy to unit-test.
 * The booking service, the reception screen and (Phase 5) the chatbot all use it.
 */

export type ScheduleSession = {
  dayOfWeek: number; // 0 = Sunday ... 6 = Saturday
  startTime: string; // "HH:mm"
  endTime: string; // "HH:mm"
  slotMinutes: number;
  maxPatients: number;
};

export type Leave = { from: string; to: string; reason?: string }; // inclusive YYYY-MM-DD range

// An appointment that currently holds a slot (booked / checked_in / in_consultation)
export type ActiveBooking = { slotTime: string; sessionKey: string };

export type SlotUnavailableReason = "booked" | "past" | "session_full";

export type Slot = {
  time: string;
  sessionKey: string;
  sessionLabel: string;
  available: boolean;
  reason?: SlotUnavailableReason;
};

export type SessionSummary = {
  sessionKey: string;
  label: string;
  labelBn: string;
  startTime: string;
  endTime: string;
  capacity: number;
  booked: number;
  remaining: number;
  isFull: boolean;
};

export type DaySlots = {
  date: string;
  onLeave: boolean;
  leaveReason?: string;
  sessions: SessionSummary[];
  slots: Slot[];
  availableCount: number;
  nextAvailable: Slot | null;
};

export type SlotEngineInput = {
  date: string;
  sessions: ScheduleSession[];
  leaves: Leave[];
  bookings: ActiveBooking[];
  // Only when `date` is today: minutes since midnight (Dhaka). Slots at or before it are "past".
  nowMinutes?: number | null;
};

/** Stable id of a session within a day, e.g. "09:00-13:00" */
export const sessionKeyOf = (s: Pick<ScheduleSession, "startTime" | "endTime">) => `${s.startTime}-${s.endTime}`;

export const findLeave = (leaves: Leave[], date: string): Leave | undefined =>
  leaves.find((l) => l.from <= date && date <= l.to);

/** All slot start times of one session, e.g. 09:00, 09:15, ... (last slot must END by endTime) */
export const slotTimesOf = (session: ScheduleSession): string[] => {
  const times: string[] = [];
  const end = toMinutes(session.endTime);
  for (let t = toMinutes(session.startTime); t + session.slotMinutes <= end; t += session.slotMinutes) {
    times.push(toHHMM(t));
  }
  return times;
};

export const computeDaySlots = ({ date, sessions, leaves, bookings, nowMinutes = null }: SlotEngineInput): DaySlots => {
  const leave = findLeave(leaves, date);
  const empty: DaySlots = { date, onLeave: Boolean(leave), leaveReason: leave?.reason, sessions: [], slots: [], availableCount: 0, nextAvailable: null };
  if (leave) return empty;

  const day = weekdayOf(date);
  const todaysSessions = sessions
    .filter((s) => s.dayOfWeek === day)
    .sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));

  const takenTimes = new Set(bookings.map((b) => b.slotTime));
  const summaries: SessionSummary[] = [];
  const slots: Slot[] = [];

  for (const session of todaysSessions) {
    const key = sessionKeyOf(session);
    const times = slotTimesOf(session);
    const label = sessionLabel(session.startTime);
    // A session can have more 15-minute slots than the doctor is willing to see
    const capacity = Math.min(session.maxPatients, times.length);
    const booked = bookings.filter((b) => b.sessionKey === key).length;
    const isFull = booked >= capacity;

    summaries.push({
      sessionKey: key,
      label: label.label,
      labelBn: label.labelBn,
      startTime: session.startTime,
      endTime: session.endTime,
      capacity,
      booked,
      remaining: Math.max(0, capacity - booked),
      isFull,
    });

    for (const time of times) {
      let reason: SlotUnavailableReason | undefined;
      if (takenTimes.has(time)) reason = "booked";
      else if (nowMinutes !== null && toMinutes(time) <= nowMinutes) reason = "past";
      else if (isFull) reason = "session_full";
      slots.push({ time, sessionKey: key, sessionLabel: label.label, available: !reason, ...(reason && { reason }) });
    }
  }

  const available = slots.filter((s) => s.available);
  return { ...empty, sessions: summaries, slots, availableCount: available.length, nextAvailable: available[0] ?? null };
};

/**
 * Validation for the schedule editor and the API: every session must end after it
 * starts, fit at least one slot, and not overlap another session on the same day.
 * Returns human-readable problems (empty array = valid).
 */
export const validateSessions = (sessions: ScheduleSession[]): string[] => {
  const problems: string[] = [];
  const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  sessions.forEach((s) => {
    if (toMinutes(s.endTime) <= toMinutes(s.startTime)) {
      problems.push(`${DAY[s.dayOfWeek]} ${s.startTime}-${s.endTime}: end time must be after start time`);
    } else if (toMinutes(s.startTime) + s.slotMinutes > toMinutes(s.endTime)) {
      problems.push(`${DAY[s.dayOfWeek]} ${s.startTime}-${s.endTime}: session is shorter than one slot`);
    }
  });
  for (let day = 0; day < 7; day++) {
    const list = sessions
      .filter((s) => s.dayOfWeek === day)
      .sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
    for (let i = 1; i < list.length; i++) {
      if (toMinutes(list[i].startTime) < toMinutes(list[i - 1].endTime)) {
        problems.push(`${DAY[day]}: ${sessionKeyOf(list[i - 1])} overlaps ${sessionKeyOf(list[i])}`);
      }
    }
  }
  return problems;
};
