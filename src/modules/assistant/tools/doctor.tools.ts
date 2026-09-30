/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from "zod";
import { escapeRegex } from "../../../utils/escapeRegex";
import { addDays, DATE_PATTERN, todayInDhaka } from "../../../utils/date";
import { LabTestModel } from "../../hospital/catalog/catalog.models";
import { searchDoctorsByText } from "../../hospital/doctor/doctor.service";
import { DoctorModel } from "../../hospital/doctor/doctor.model";
import { getDaySlotsFor, getDoctorSlots } from "../../hospital/scheduling/scheduling.service";
import { getSettings } from "../../hospital/settings/settings.service";
import type { OutboundMessage } from "../assistant.types";
import { dateLabel, taka, time12 } from "./shared";
import { defineTool } from "./types";

const MAX_DOCTORS = 6;
const MAX_SLOTS = 8;

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
    "weekly schedule and the next available date/time (from `date` if given).",
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
              description: `${d.department.name} · ${taka(d.consultationFee)}${next ? ` · ${dateLabel(next.date)} ${time12(next.time)}` : ""}`,
              meta: {
                initials: initials(d.name),
                department: d.department.name,
                departmentBn: d.department.nameBn,
                specialization: d.specialization,
                fee: taka(d.consultationFee),
                nextAvailable: next ? `${dateLabel(next.date)}, ${time12(next.time)}` : null,
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
            nextAvailable: next,
          }))
        : { found: 0, note: "No active doctor matches. Offer list_departments." },
      ui,
    };
  },
});

export const getAvailableSlots = defineTool({
  name: "get_available_slots",
  description: "Free appointment times of one doctor on one date (from search_doctors).",
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
    const day = await getDoctorSlots(doctorId, date);
    const free = day.slots.filter((s) => s.available);
    // Spread the offer over the day instead of only the first minutes
    const step = Math.max(1, Math.floor(free.length / MAX_SLOTS));
    const offered = free.filter((_, i) => i % step === 0).slice(0, MAX_SLOTS);
    const reason = day.onLeave
      ? "The doctor is on leave that day."
      : !day.sessions.length
        ? "The doctor does not sit that day."
        : !free.length
          ? "No free slots that day."
          : null;
    return {
      summary: `${free.length} free slots`,
      data: {
        date,
        available: free.length,
        times: offered.map((s) => s.time),
        ...(reason && { message: reason, next: await nextAvailable(doctorId, addDays(date, 1)) }),
      },
      ui: offered.length
        ? [
            {
              type: "list",
              kind: "slots",
              text: `${dateLabel(date)} — সময় বাছুন · Choose a time`,
              button: "সময় দেখুন",
              items: offered.map((s) => ({
                id: `slot|${doctorId}|${date}|${s.time}`,
                label: time12(s.time),
                description: s.sessionLabel,
                meta: { session: s.sessionLabel },
              })),
            },
          ]
        : [],
    };
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
