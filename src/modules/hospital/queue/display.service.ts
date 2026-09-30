/* eslint-disable @typescript-eslint/no-explicit-any */
import { nowMinutesInDhaka, sessionLabel, todayInDhaka, toMinutes, weekdayOf } from "../../../utils/date";
import { AppointmentModel } from "../appointment/appointment.model";
import { DoctorModel } from "../doctor/doctor.model";
import { findLeave } from "../scheduling/slotEngine";
import { getSettings } from "../settings/settings.service";
import { compareQueue } from "./queue.service";

export { assertDisplayKey, isValidDisplayKey } from "./display-key";

/** "Rahim Hossain" → "R*** H***" — enough for a patient to recognise themselves, useless to anyone else */
export const maskName = (name: string): string =>
  name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((w) => `${w[0]!.toUpperCase()}***`)
    .join(" ");

// A doctor appears on the TV from 30 minutes before a session until 60 minutes after it
const SHOW_BEFORE = 30;
const SHOW_AFTER = 60;

/**
 * Waiting-room TV data. PUBLIC screen, so it contains ONLY: doctor name, department,
 * room, current serial and the next three serials with masked names. Never a phone
 * number, a full name, a patient code or anything clinical.
 */
export const getDisplayBoard = async () => {
  const date = todayInDhaka();
  const now = nowMinutesInDhaka();
  const [settings, doctors, appts] = await Promise.all([
    getSettings(),
    DoctorModel.find({ isActive: true }).populate("department", "name nameBn").sort({ roomNo: 1 }),
    AppointmentModel.find({ date, status: { $in: ["checked_in", "in_consultation"] } }, { doctor: 1, status: 1, priority: 1, serialNo: 1, patient: 1 }).populate(
      "patient",
      "name",
    ),
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
      const session = leave
        ? undefined
        : (d.sessions ?? []).find((s: any) => s.dayOfWeek === weekdayOf(date) && toMinutes(s.startTime) - SHOW_BEFORE <= now && now < toMinutes(s.endTime) + SHOW_AFTER);
      if (!session && line.length === 0) return null; // not in session → not on the TV
      const current = line.find((a) => a.status === "in_consultation");
      return {
        doctorId: String(d._id),
        doctorName: `${d.title ?? ""} ${d.name}`.trim(),
        doctorNameBn: d.nameBn ?? null,
        department: d.department?.name ?? "",
        departmentBn: d.department?.nameBn ?? "",
        roomNo: d.roomNo ?? "",
        session: session ? { ...sessionLabel(session.startTime), startTime: session.startTime, endTime: session.endTime } : null,
        nowServing: current ? { serialNo: current.serialNo, maskedName: maskName(current.patient?.name ?? "") } : null,
        next: line
          .filter((a) => a.status === "checked_in")
          .slice(0, 3)
          .map((a) => ({ serialNo: a.serialNo, maskedName: maskName(a.patient?.name ?? ""), priority: a.priority === "normal" ? undefined : a.priority })),
        waitingCount: line.filter((a) => a.status === "checked_in").length,
      };
    })
    .filter(Boolean);

  return {
    date,
    generatedAt: new Date().toISOString(),
    hospital: { name: settings.name, nameBn: settings.nameBn, emergencyPhone: settings.emergencyPhone },
    notice: settings.displayNotice ?? "",
    doctors: cards,
  };
};
