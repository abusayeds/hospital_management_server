/* eslint-disable @typescript-eslint/no-explicit-any */
import { nowMinutesInDhaka, sessionLabel, todayInDhaka, toMinutes, weekdayOf } from "../../../utils/date";
import { AppointmentModel } from "../appointment/appointment.model";
import { DoctorModel } from "../doctor/doctor.model";
import { findLeave } from "../scheduling/slotEngine";
import { getSettings } from "../settings/settings.service";
import { compareQueue } from "./queue.service";

/** "Rahim Hossain" → "R*** H***" — enough for a patient to recognise themselves, useless to anyone else */
export const maskName = (name: string): string =>
  name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((w) => `${w[0]!.toUpperCase()}***`)
    .join(" ");

// A doctor counts as "in session" from 30 minutes before a session until 60 minutes after it
const SHOW_BEFORE = 30;
const SHOW_AFTER = 60;

// Where a doctor is today; the board lists doctors in this order
const STATE_ORDER = { in_session: 0, later: 1, done: 2, on_leave: 3, off: 4 } as const;
type DoctorState = keyof typeof STATE_ORDER;

// The board is public (anyone can open it), so many viewers share one database read:
// a result is reused for a few seconds and dropped as soon as any queue changes.
const CACHE_MS = 5_000;
let cached: { at: number; board: ReturnType<typeof buildDisplayBoard> } | null = null;

export const forgetDisplayBoard = () => {
  cached = null;
};

export const getDisplayBoard = () => {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.board;
  const board = buildDisplayBoard();
  cached = { at: Date.now(), board };
  board.catch(() => forgetDisplayBoard());
  return board;
};

/**
 * Public queue board (waiting-room TV and anyone's phone, no login). Lists EVERY active
 * doctor with today's state. It contains ONLY: doctor name, department, room, session
 * times, current serial and the next three serials with masked names. Never a phone
 * number, a full name, a patient code, a leave reason or anything clinical.
 */
const buildDisplayBoard = async () => {
  const date = todayInDhaka();
  const now = nowMinutesInDhaka();
  const [settings, doctors, appts] = await Promise.all([
    getSettings(),
    DoctorModel.find({ isActive: true }).populate("department", "name nameBn").sort({ roomNo: 1 }),
    AppointmentModel.find(
      { date, status: { $in: ["checked_in", "in_consultation"] } },
      { doctor: 1, status: 1, priority: 1, serialNo: 1, patient: 1 },
    ).populate("patient", "name"),
  ]);

  const byDoctor = new Map<string, any[]>();
  for (const a of appts as any[]) {
    const key = String(a.doctor);
    byDoctor.set(key, [...(byDoctor.get(key) ?? []), a]);
  }

  const cards = doctors
    .map((d: any) => {
      const line = (byDoctor.get(String(d._id)) ?? []).sort(compareQueue);
      const leave = findLeave(d.leaves ?? [], date);
      const today = leave
        ? []
        : (d.sessions ?? [])
            .filter((s: any) => s.dayOfWeek === weekdayOf(date))
            .sort((a: any, b: any) => toMinutes(a.startTime) - toMinutes(b.startTime));
      const session = today.find(
        (s: any) => toMinutes(s.startTime) - SHOW_BEFORE <= now && now < toMinutes(s.endTime) + SHOW_AFTER,
      );
      const upcoming = today.find((s: any) => toMinutes(s.startTime) - SHOW_BEFORE > now);
      const state: DoctorState =
        session || line.length ? "in_session" : leave ? "on_leave" : upcoming ? "later" : today.length ? "done" : "off";
      const current = line.find((a) => a.status === "in_consultation");
      return {
        doctorId: String(d._id),
        doctorName: `${d.title ?? ""} ${d.name}`.trim(),
        doctorNameBn: d.nameBn ?? null,
        department: d.department?.name ?? "",
        departmentBn: d.department?.nameBn ?? "",
        roomNo: d.roomNo ?? "",
        session: session
          ? { ...sessionLabel(session.startTime), startTime: session.startTime, endTime: session.endTime }
          : null,
        state,
        nextSession: upcoming
          ? { ...sessionLabel(upcoming.startTime), startTime: upcoming.startTime, endTime: upcoming.endTime }
          : null,
        nowServing: current ? { serialNo: current.serialNo, maskedName: maskName(current.patient?.name ?? "") } : null,
        next: line
          .filter((a) => a.status === "checked_in")
          .slice(0, 3)
          .map((a) => ({
            serialNo: a.serialNo,
            maskedName: maskName(a.patient?.name ?? ""),
            priority: a.priority === "normal" ? undefined : a.priority,
          })),
        waitingCount: line.filter((a) => a.status === "checked_in").length,
      };
    })
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]); // stable: room order within each group

  return {
    date,
    generatedAt: new Date().toISOString(),
    hospital: { name: settings.name, nameBn: settings.nameBn, emergencyPhone: settings.emergencyPhone },
    notice: settings.displayNotice ?? "",
    doctors: cards,
  };
};
