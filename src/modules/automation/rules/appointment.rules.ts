/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from "zod";
import { addDays, TIME_PATTERN } from "../../../utils/date";
import { ACTIVE_STATUSES, AppointmentModel } from "../../hospital/appointment/appointment.model";
import { findLeave } from "../../hospital/scheduling/slotEngine";
import { cancelOpenJobs } from "../jobs";
import { addMinutes, atDhaka, dhakaDate } from "../time";
import { registerRule } from "./registry";
import { appointmentVariables, fail, languageOf, loadAppointment, toAppointmentPatient } from "./shared";
import type { PlannedJob, RuleDefinition } from "./types";

/**
 * APPOINTMENT RULES — confirmation, day-before reminder, same-day reminder, no-show rebook offer and
 * doctor-absence notice. Dedupe keys: apt:<appointmentId>:<step>.
 */

const time = z.string().regex(TIME_PATTERN, "Use HH:mm");

/** Cancel this rule's open jobs when the appointment no longer needs them */
const cancelFor = (ruleKey: string, reason: string) => async (p: { appointmentId: string }) => {
  await cancelOpenJobs({ scopeType: "appointment", scopeId: p.appointmentId, ruleKey }, reason);
};

// ------------------------------------------------------------------ 1. confirmation

type ConfirmConfig = { directionsUrl: string };

export const appointmentConfirmation = registerRule({
  key: "appointment_confirmation",
  title: "Appointment confirmation",
  description:
    "Right after a booking from any source: doctor, date, time, serial, room, fee and Confirm / Reschedule / Cancel buttons. Walk-ins get a short welcome with the serial.",
  trigger: "appointment.booked, appointment.rescheduled",
  category: "reminders",
  enabledByDefault: true,
  defaults: {
    directionsUrl: "",
    quietHoursOverride: false,
    dailyLimit: 1000,
    channels: ["whatsapp", "sms"],
    templateKey: "appointment_confirmation",
  },
  configSchema: z.object({ directionsUrl: z.string().url().or(z.literal("")) }).partial(),
  events: {
    "appointment.booked": async (p, { now }) => [
      {
        dedupeKey: `apt:${p.appointmentId}:confirm`,
        scopeType: "appointment",
        scopeId: p.appointmentId,
        scheduledFor: now,
        patientId: p.patientId,
        data: { source: p.source },
      },
    ],
    "appointment.rescheduled": async (p, { now }) => [
      {
        dedupeKey: `apt:${p.toAppointmentId}:confirm`,
        scopeType: "appointment",
        scopeId: p.toAppointmentId,
        scheduledFor: now,
        patientId: p.patientId,
        data: { rescheduledFrom: p.fromAppointmentId },
        supersedes: p.fromAppointmentId,
      },
    ],
  },
  async prepare(job, { config, settings }) {
    const a = await loadAppointment(job.scopeId);
    if (!a) return fail("Appointment not found");
    const walkIn = a.source === "walk_in";
    if (!["booked", ...(walkIn ? ["checked_in"] : [])].includes(a.status))
      return fail(`Appointment is ${a.status.replace("_", " ")}`);
    const lang = languageOf(a.patient);
    return {
      ...toAppointmentPatient(
        a,
        { ...appointmentVariables(a, settings, lang), directions: config.directionsUrl },
        lang,
      ),
      ...(walkIn && { templateKey: "walk_in_welcome" }),
    };
  },
} satisfies RuleDefinition<ConfirmConfig>);

// ------------------------------------------------------------------ 2. day-before reminder

type DayBeforeConfig = { sendAt: string };

const dayBeforeJob = (a: any, sendAt: string): PlannedJob => ({
  dedupeKey: `apt:${a._id ?? a.appointmentId}:T-1d`,
  scopeType: "appointment",
  scopeId: String(a._id ?? a.appointmentId),
  scheduledFor: atDhaka(addDays(a.date, -1), sendAt),
  patientId: String(a.patient?._id ?? a.patient ?? a.patientId),
  data: { date: a.date },
});

export const reminderDayBefore = registerRule({
  key: "reminder_day_before",
  title: "Day-before reminder",
  description:
    "For every appointment tomorrow that is still booked, a reminder the evening before (default 18:00) with the same details and action buttons. Uses the approved template outside WhatsApp's 24-hour window.",
  trigger: "hourly planner",
  category: "reminders",
  countsTowardPhoneCap: true,
  enabledByDefault: true,
  cadenceMinutes: 60,
  defaults: {
    sendAt: "18:00",
    quietHoursOverride: false,
    dailyLimit: 1000,
    channels: ["whatsapp", "sms"],
    templateKey: "reminder_day_before",
  },
  configSchema: z.object({ sendAt: time }).partial(),
  async plan({ now, config }) {
    const tomorrow = addDays(dhakaDate(now), 1);
    const appts = await AppointmentModel.find({ date: tomorrow, status: "booked" })
      .select("date patient createdAt")
      .lean<any[]>();
    // Booked a moment ago? The confirmation just went out — no reminder on top of it
    return appts
      .map((a) => dayBeforeJob(a, config.sendAt))
      .filter((j, i) => appts[i].createdAt < addMinutes(j.scheduledFor, -120));
  },
  events: {
    "appointment.rescheduled": async (p, { now, config }) => {
      if (p.date === addDays(dhakaDate(now), 1))
        return [{ ...dayBeforeJob({ ...p, _id: p.toAppointmentId }, config.sendAt), supersedes: p.fromAppointmentId }];
      await cancelOpenJobs(
        { scopeType: "appointment", scopeId: p.fromAppointmentId, ruleKey: "reminder_day_before" },
        "Appointment rescheduled",
      );
    },
    "appointment.cancelled": cancelFor("reminder_day_before", "Appointment cancelled"),
  },
  async prepare(job, { settings }) {
    const a = await loadAppointment(job.scopeId);
    if (!a) return fail("Appointment not found");
    if (a.status !== "booked") return fail(`Appointment is ${a.status.replace("_", " ")}`);
    if (a.date !== job.data.date) return fail("Appointment moved to another date");
    const lang = languageOf(a.patient);
    return toAppointmentPatient(a, appointmentVariables(a, settings, lang), lang);
  },
  async postSend(job) {
    await AppointmentModel.updateOne({ _id: job.scopeId }, { $set: { lastReminderSentAt: new Date() } });
  },
} satisfies RuleDefinition<DayBeforeConfig>);

// ------------------------------------------------------------------ 3. same-day reminder

type SameDayConfig = { minutesBefore: number; queueLink: string; directionsUrl: string };

export const reminderSameDay = registerRule({
  key: "reminder_same_day",
  title: "Same-day arrival reminder",
  description:
    "For appointments later today, a reminder shortly before the slot (default 90 minutes) with the queue link and directions. Cancelled automatically when the patient checks in.",
  trigger: "every 15 minutes",
  category: "reminders",
  countsTowardPhoneCap: true,
  enabledByDefault: true,
  cadenceMinutes: 15,
  defaults: {
    minutesBefore: 90,
    queueLink: "",
    directionsUrl: "",
    quietHoursOverride: false,
    dailyLimit: 1000,
    channels: ["whatsapp", "sms"],
    templateKey: "reminder_same_day",
  },
  configSchema: z
    .object({
      minutesBefore: z.number().int().min(15).max(360),
      queueLink: z.string().url().or(z.literal("")),
      directionsUrl: z.string().url().or(z.literal("")),
    })
    .partial(),
  async plan({ now, config }) {
    const today = dhakaDate(now);
    const appts = await AppointmentModel.find({ date: today, status: "booked" })
      .select("date slotTime patient createdAt")
      .lean<any[]>();
    const jobs: PlannedJob[] = [];
    for (const a of appts) {
      const slot = atDhaka(a.date, a.slotTime);
      const at = addMinutes(slot, -config.minutesBefore);
      // Only upcoming slots, and not for a booking made within the last 30 minutes before the reminder
      if (slot <= now || a.createdAt > addMinutes(at, -30)) continue;
      jobs.push({
        dedupeKey: `apt:${a._id}:T-${config.minutesBefore}m`,
        scopeType: "appointment",
        scopeId: String(a._id),
        scheduledFor: at,
        patientId: String(a.patient),
        data: { date: a.date, slotTime: a.slotTime },
      });
    }
    return jobs;
  },
  events: {
    "appointment.checked_in": cancelFor("reminder_same_day", "Patient already checked in"),
    "appointment.cancelled": cancelFor("reminder_same_day", "Appointment cancelled"),
    "appointment.rescheduled": async (p) => {
      // The next planner run creates the reminder for the new slot (if it is today)
      await cancelOpenJobs(
        { scopeType: "appointment", scopeId: p.fromAppointmentId, ruleKey: "reminder_same_day" },
        "Appointment rescheduled",
      );
    },
  },
  async prepare(job, { now, config, settings }) {
    const a = await loadAppointment(job.scopeId);
    if (!a) return fail("Appointment not found");
    if (a.status === "checked_in" || a.status === "in_consultation") return fail("Patient already checked in");
    if (a.status !== "booked") return fail(`Appointment is ${a.status.replace("_", " ")}`);
    if (a.date !== dhakaDate(now) || a.slotTime !== job.data.slotTime) return fail("Appointment time changed");
    if (atDhaka(a.date, a.slotTime) <= now) return fail("The slot has already started");
    const lang = languageOf(a.patient);
    return toAppointmentPatient(
      a,
      { ...appointmentVariables(a, settings, lang), queueLink: config.queueLink, directions: config.directionsUrl },
      lang,
    );
  },
  async postSend(job) {
    await AppointmentModel.updateOne({ _id: job.scopeId }, { $set: { lastReminderSentAt: new Date() } });
  },
} satisfies RuleDefinition<SameDayConfig>);

// ------------------------------------------------------------------ 4. no-show rebook offer

type NoShowConfig = { delayMinutes: number };

export const noShowRebook = registerRule({
  key: "no_show_rebook",
  title: "No-show follow-up",
  description:
    'A few hours after a missed appointment: "we missed you today" with Rebook / Not now / Don\'t contact me. Rebook opens the booking chat with the same doctor.',
  trigger: "appointment.no_show (delayed)",
  category: "followUps",
  countsTowardPhoneCap: true,
  enabledByDefault: true,
  defaults: {
    delayMinutes: 180,
    quietHoursOverride: false,
    dailyLimit: 500,
    channels: ["whatsapp", "sms"],
    templateKey: "no_show_rebook",
  },
  configSchema: z
    .object({
      delayMinutes: z
        .number()
        .int()
        .min(0)
        .max(48 * 60),
    })
    .partial(),
  events: {
    "appointment.no_show": async (p, { now, config }) => [
      {
        dedupeKey: `apt:${p.appointmentId}:no-show`,
        scopeType: "appointment",
        scopeId: p.appointmentId,
        scheduledFor: addMinutes(now, config.delayMinutes),
        patientId: p.patientId,
        data: { doctorId: p.doctorId },
      },
    ],
  },
  async prepare(job, { settings }) {
    const a = await loadAppointment(job.scopeId);
    if (!a) return fail("Appointment not found");
    if (a.status !== "no_show") return fail(`Appointment is now ${a.status.replace("_", " ")}`);
    const rebooked = await AppointmentModel.exists({
      patient: a.patient._id,
      doctor: a.doctor._id,
      status: { $in: ACTIVE_STATUSES },
      date: { $gte: a.date },
    });
    if (rebooked) return fail("Patient already booked again");
    const lang = languageOf(a.patient);
    return toAppointmentPatient(a, appointmentVariables(a, settings, lang), lang);
  },
} satisfies RuleDefinition<NoShowConfig>);

// ------------------------------------------------------------------ 9. doctor absence

type AbsenceConfig = { daysAhead: number };

export const doctorAbsence = registerRule({
  key: "doctor_absence",
  title: "Doctor absence alert",
  description:
    "When leave is added for a doctor today or tomorrow, every booked patient gets an apology and Reschedule / Cancel buttons; the appointments are flagged for reception.",
  trigger: "doctor.leave_added",
  category: "essential",
  essential: true, // the hospital cannot keep the booking — patients must know even after STOP
  enabledByDefault: true,
  defaults: {
    daysAhead: 2,
    quietHoursOverride: true,
    dailyLimit: 1000,
    channels: ["whatsapp", "sms"],
    templateKey: "doctor_absence",
  },
  configSchema: z.object({ daysAhead: z.number().int().min(1).max(14) }).partial(),
  events: {
    "doctor.leave_added": async (p, { now, config }) => {
      const today = dhakaDate(now);
      const from = p.from > today ? p.from : today;
      const lastDay = addDays(today, config.daysAhead - 1);
      const to = p.to < lastDay ? p.to : lastDay;
      if (from > to) return [];
      const appts = await AppointmentModel.find({
        doctor: p.doctorId,
        date: { $gte: from, $lte: to },
        status: "booked",
      })
        .select("date patient")
        .lean<any[]>();
      // Reception sees these highlighted right away, before any message goes out
      await AppointmentModel.updateMany({ _id: { $in: appts.map((a) => a._id) } }, { $set: { doctorAbsent: true } });
      return appts.map((a) => ({
        dedupeKey: `apt:${a._id}:absence:${p.from}`,
        scopeType: "appointment" as const,
        scopeId: String(a._id),
        scheduledFor: now,
        patientId: String(a.patient),
        urgent: a.date === today,
        data: { date: a.date },
      }));
    },
  },
  async prepare(job, { settings }) {
    const a = await loadAppointment(job.scopeId);
    if (!a) return fail("Appointment not found");
    if (a.status !== "booked") return fail(`Appointment is ${a.status.replace("_", " ")}`);
    if (!findLeave(a.doctor?.leaves ?? [], a.date)) return fail("The doctor's leave was removed");
    const lang = languageOf(a.patient);
    return toAppointmentPatient(a, appointmentVariables(a, settings, lang), lang);
  },
  async postSend(job) {
    await AppointmentModel.updateOne({ _id: job.scopeId }, { $set: { doctorAbsentNotifiedAt: new Date() } });
  },
} satisfies RuleDefinition<AbsenceConfig>);
