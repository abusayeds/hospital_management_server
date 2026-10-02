/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from "zod";
import { escapeRegex } from "../../../utils/escapeRegex";
import { addDays, DATE_PATTERN, todayInDhaka } from "../../../utils/date";
import { LabTestModel } from "../../hospital/catalog/catalog.models";
import { searchDoctorsByText } from "../../hospital/doctor/doctor.service";
import { DoctorModel } from "../../hospital/doctor/doctor.model";
import { getDaySlotsFor, loadActiveDoctor } from "../../hospital/scheduling/scheduling.service";
import { getSettings } from "../../hospital/settings/settings.service";
import type { OutboundMessage } from "../assistant.types";
import { dateLabel, taka, time12 } from "./shared";
import { defineTool } from "./types";

const MAX_DOCTORS = 6;

/** First date (from `from`, within the booking window) with a free slot, using the slot engine */
const nextAvailable = async (doctorId: string, from: string) => {
  const doctor = await DoctorModel.findById(doctorId);
  if (!doctor) return null;
  const { bookingWindowDays } = await getSettings();
  const last = addDays(todayInDhaka(), bookingWindowDays);
  for (let date = from; date <= last; date = addDays(date, 1)) {
    const day = await getDaySlotsFor(doctor, date);
    if (day.nextAvailable) return { date, time: day.nextAvailable.time };
  }
  return null;
};

const initials = (name: string) =>
  name
    .replace(/^(prof\.?|dr\.?|assoc\.?)\s*/gi, "")
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

export const searchDoctors = defineTool({
  name: "search_doctors",
  description:
    "Find active doctors by department (English or Bangla, e.g. 'Cardiology', 'শিশু') and/or name, with fee, " +
    "weekly schedule and the next date with a free serial (from `date` if given).",
  parameters: {
    type: "object",
    properties: {
      department: { type: "string" },
      name: { type: "string", description: "Part of the doctor's name" },
      date: { type: "string", description: "YYYY-MM-DD — look for availability from this date" },
    },
  },
  schema: z.object({
    department: z.string().trim().max(60).optional(),
    name: z.string().trim().max(60).optional(),
    date: z.string().regex(DATE_PATTERN).optional(),
  }),
  run: async ({ department, name, date }) => {
    const from = date && date >= todayInDhaka() ? date : todayInDhaka();
    const doctors = (await searchDoctorsByText({ department, name })).slice(0, MAX_DOCTORS);
    const rows = await Promise.all(doctors.map(async (d) => ({ d, next: await nextAvailable(d.id, from) })));
    const ui: OutboundMessage[] = rows.length
      ? [
          {
            type: "list",
            kind: "doctors",
            text: "ডাক্তার বাছুন · Choose a doctor",
            button: "ডাক্তার দেখুন",
            items: rows.map(({ d, next }) => ({
              id: `doctor|${d.id}`,
              label: d.displayName,
              description: `${d.department.name} · ${taka(d.consultationFee)}${next ? ` · ${dateLabel(next.date)}` : ""}`,
              meta: {
                initials: initials(d.name),
                department: d.department.name,
                departmentBn: d.department.nameBn,
                specialization: d.specialization,
                fee: taka(d.consultationFee),
                nextAvailable: next ? dateLabel(next.date) : null,
              },
            })),
          },
        ]
      : [];
    return {
      summary: `${rows.length} doctors`,
      data: rows.length
        ? rows.map(({ d, next }) => ({
            doctorId: d.id,
            name: d.displayName,
            department: d.department.name,
            specialization: d.specialization,
            fee: taka(d.consultationFee),
            followUpFee: taka(d.followUpFee),
            schedule: d.scheduleText,
            nextAvailableDate: next?.date ?? null,
          }))
        : { found: 0, note: "No active doctor matches. Offer list_departments." },
      ui,
    };
  },
});

/** "সকাল 9:00 AM – 1:00 PM" for each sitting of the day */
const sittingText = (sessions: { labelBn: string; startTime: string; endTime: string }[]) =>
  sessions.map((s) => `${s.labelBn} ${time12(s.startTime)} – ${time12(s.endTime)}`).join(", ");

/**
 * One doctor on one date: when they sit, how many are booked, and roughly when the NEXT serial will be
 * seen (the first free place in the queue). The patient never picks a time: booking always takes the
 * next serial, and the serial + estimated time are told after Confirm.
 */
export const doctorDayCard = async (doctorId: string, date: string) => {
  const doctor: any = await loadActiveDoctor(doctorId);
  const day = await getDaySlotsFor(doctor, date);
  const name = `${doctor.title ?? ""} ${doctor.name}`.trim();
  const booked = day.sessions.reduce((n, s) => n + s.booked, 0);
  const first = day.nextAvailable;
  const reason = day.onLeave
    ? "The doctor is on leave that day."
    : !day.sessions.length
      ? "The doctor does not sit that day."
      : !first
        ? "No serials left that day."
        : null;
  const next = reason ? await nextAvailable(doctorId, addDays(date, 1)) : null;
  const card: OutboundMessage = {
    type: "card",
    kind: "doctor_day",
    title: `${name} · ${dateLabel(date)}`,
    fields: [
      ...(day.sessions.length ? [{ label: "বসবেন · Sitting", value: sittingText(day.sessions) }] : []),
      ...(day.sessions.length ? [{ label: "সিরিয়াল হয়েছে · Booked", value: `${booked} জন` }] : []),
      first
        ? { label: "পরের সিরিয়ালের আনুমানিক সময় · Next serial ~", value: `~${time12(first.time)}` }
        : {
            label: "অবস্থা · Status",
            value: day.onLeave
              ? "এই দিন ছুটিতে · On leave"
              : !day.sessions.length
                ? "এই দিন বসেন না · Not sitting"
                : "এই দিনের সিরিয়াল শেষ · Fully booked",
          },
    ],
    data: { doctorId, date },
    actions: [
      ...(first ? [{ id: `book|${doctorId}|${date}`, label: "✅ এই দিনে সিরিয়াল নিন · Book" }] : []),
      ...(next ? [{ id: `day|${doctorId}|${next.date}`, label: `📅 ${dateLabel(next.date)}` }] : []),
    ],
  };
  return {
    card,
    first,
    data: {
      doctor: name,
      date,
      sitting: day.sessions.map((s) => ({ session: s.label, from: time12(s.startTime), to: time12(s.endTime) })),
      bookedSoFar: booked,
      nextSerialEstimatedTime: first ? time12(first.time) : null,
      ...(reason && { message: reason, nextDateWithSerial: next?.date ?? null }),
    },
  };
};

export const getDoctorDay = defineTool({
  name: "get_doctor_day",
  description:
    "One doctor on one date: sitting hours, how many serials are booked and the estimated time of the next serial. " +
    "Never offer times to choose — booking always takes the next serial.",
  parameters: {
    type: "object",
    properties: { doctorId: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" } },
    required: ["doctorId", "date"],
  },
  schema: z.object({
    doctorId: z.string().regex(/^[a-f\d]{24}$/i, "unknown doctor"),
    date: z.string().regex(DATE_PATTERN),
  }),
  run: async ({ doctorId, date }) => {
    const { card, data, first } = await doctorDayCard(doctorId, date);
    return { summary: first ? `next serial ~${first.time}` : "no serial that day", data, ui: [card] };
  },
});

export const getTestPreparation = defineTool({
  name: "get_test_preparation",
  description: "Preparation instructions for a lab test (e.g. fasting), sample type and report time.",
  parameters: { type: "object", properties: { testName: { type: "string" } }, required: ["testName"] },
  schema: z.object({ testName: z.string().trim().min(2).max(80) }),
  run: async ({ testName }) => {
    const rx = new RegExp(escapeRegex(testName), "i");
    const tests = await LabTestModel.find({ isActive: true, $or: [{ name: rx }, { code: rx }] })
      .limit(3)
      .lean<any[]>();
    return {
      summary: `${tests.length} tests`,
      data: tests.length
        ? tests.map((t) => ({
            test: t.name,
            sample: t.sampleType,
            preparation: t.preparationNote || "No special preparation needed.",
            preparationBn: t.preparationNoteBn || "বিশেষ কোনো প্রস্তুতি লাগবে না।",
            reportInHours: t.turnaroundHours,
            price: taka(t.price),
          }))
        : { found: 0, note: "Test not in the catalogue — try search_knowledge_base or offer a staff member." },
    };
  },
});
