/* eslint-disable @typescript-eslint/no-explicit-any */
import { Types } from "mongoose";
import { z } from "zod";
import { addDays, TIME_PATTERN } from "../../../utils/date";
import { LabOrderModel } from "../../clinical/lab/labOrder.model";
import { VisitModel } from "../../clinical/visits/visit.model";
import { AppointmentModel } from "../../hospital/appointment/appointment.model";
import { DoctorModel } from "../../hospital/doctor/doctor.model";
import { addMinutes, atDhaka, dhakaDate } from "../time";
import { registerRule } from "./registry";
import { doctorNameFor, fail, firstName, hospitalNameFor, languageOf, loadPatient } from "./shared";
import type { PlannedJob, RuleDefinition } from "./types";

/**
 * CLINICAL RULES — follow-up reminder, lab report ready, lab sample reminder.
 * These messages NEVER contain results, diagnoses or medicines: test NAMES and dates only.
 */

const time = z.string().regex(TIME_PATTERN, "Use HH:mm");

// ------------------------------------------------------------------ 5. follow-up reminder

type FollowUpConfig = { daysBefore: number; sendAt: string; windowDays: number };

const followUpJob = (v: any, config: FollowUpConfig, today: string): PlannedJob | null => {
  const date = v.followUpDate;
  if (!date || date <= today) return null;
  const sendDay = addDays(date, -config.daysBefore);
  return {
    dedupeKey: `fup:${v.visitId}:D-${config.daysBefore}`,
    scopeType: "visit",
    scopeId: v.visitId,
    // Follow-up sooner than N days away → remind at the next send time instead
    scheduledFor: atDhaka(sendDay > today ? sendDay : today, config.sendAt),
    patientId: v.patientId,
    data: { followUpDate: date, doctorId: v.doctorId },
  };
};

export const followUpReminder = registerRule({
  key: "follow_up_reminder",
  title: "Follow-up reminder",
  description:
    'N days (default 3) before the follow-up date the doctor set: "Dr. X recommended a follow-up on <date>. Book now?". Cancelled if the patient already booked that doctor within ±3 days.',
  trigger: "visit.closed + hourly planner",
  category: "followUps",
  countsTowardPhoneCap: true,
  enabledByDefault: true,
  cadenceMinutes: 60,
  defaults: {
    daysBefore: 3,
    sendAt: "10:00",
    windowDays: 3,
    quietHoursOverride: false,
    dailyLimit: 500,
    channels: ["whatsapp", "sms"],
    templateKey: "follow_up_reminder",
  },
  configSchema: z
    .object({
      daysBefore: z.number().int().min(1).max(30),
      sendAt: time,
      windowDays: z.number().int().min(0).max(14),
    })
    .partial(),
  events: {
    "visit.closed": async (p, { now, config }) => {
      const job = followUpJob(p, config, dhakaDate(now));
      return job ? [job] : [];
    },
  },
  // Safety net (missed events, seeded data): every closed visit whose follow-up is coming up
  async plan({ now, config }) {
    const today = dhakaDate(now);
    const visits = await VisitModel.find({
      status: "closed",
      "followUp.date": { $gt: today, $lte: addDays(today, config.daysBefore) },
    })
      .select("patient doctor followUp")
      .lean<any[]>();
    return visits
      .map((v) =>
        followUpJob(
          {
            visitId: String(v._id),
            patientId: String(v.patient),
            doctorId: String(v.doctor),
            followUpDate: v.followUp.date,
          },
          config,
          today,
        ),
      )
      .filter(Boolean) as PlannedJob[];
  },
  async prepare(job, { config, settings }) {
    const visit = await VisitModel.findById(job.scopeId).select("status followUp patient doctor").lean<any>();
    if (!visit) return fail("Visit not found");
    if (visit.status !== "closed") return fail("Visit was reopened");
    if (visit.followUp?.date !== job.data.followUpDate) return fail("Follow-up date changed or removed");
    const date = String(job.data.followUpDate);
    const booked = await AppointmentModel.exists({
      patient: visit.patient,
      doctor: visit.doctor,
      status: { $in: ["booked", "checked_in", "in_consultation", "completed"] },
      date: { $gte: addDays(date, -config.windowDays), $lte: addDays(date, config.windowDays) },
    });
    if (booked) return fail("Follow-up already booked");
    const [patient, doctor] = await Promise.all([
      loadPatient(visit.patient),
      DoctorModel.findById(visit.doctor).select("title name nameBn").lean<any>(),
    ]);
    if (!patient) return fail("Patient not found");
    const lang = languageOf(patient);
    return {
      ok: true,
      to: "patient",
      patientId: String(patient._id),
      phone: patient.phone,
      language: lang,
      variables: {
        patientName: firstName(lang === "bn" && patient.nameBn ? patient.nameBn : patient.name),
        doctorName: doctorNameFor(doctor, lang),
        followUpDate: date,
        hospital: hospitalNameFor(settings, lang),
      },
      buttonRef: String(visit._id),
      related: { type: "visit", id: String(visit._id) },
    };
  },
} satisfies RuleDefinition<FollowUpConfig>);

// ------------------------------------------------------------------ 6. lab report ready

type LabConfig = { labHours: string; labLocation: string };
const labConfigSchema = z
  .object({ labHours: z.string().trim().min(3).max(60), labLocation: z.string().trim().min(3).max(100) })
  .partial();

const labPatient = async (order: any, settings: any, extra: Record<string, unknown>) => {
  const patient = await loadPatient(order.patient);
  if (!patient) return fail("Patient not found");
  const lang = languageOf(patient);
  return {
    ok: true as const,
    to: "patient" as const,
    patientId: String(patient._id),
    phone: patient.phone as string,
    language: lang,
    variables: {
      patientName: firstName(lang === "bn" && patient.nameBn ? patient.nameBn : patient.name),
      hospital: hospitalNameFor(settings, lang),
      ...extra,
    },
    buttonRef: String(order.visit ?? order._id),
    related: { type: "lab_order" as const, id: String(order._id) },
  };
};

export const labReportReady = registerRule({
  key: "lab_report_ready",
  title: "Lab report ready",
  description:
    "As soon as a report is verified: which tests are ready and when to collect them — never the results. Urgent orders may override quiet hours.",
  trigger: "lab.report_ready",
  category: "labReports",
  enabledByDefault: true,
  cadenceMinutes: 60,
  defaults: {
    labHours: "8:00 AM – 8:00 PM",
    labLocation: "Ground floor, lab counter",
    quietHoursOverride: true,
    dailyLimit: 1000,
    channels: ["whatsapp", "sms"],
    templateKey: "lab_report_ready",
  },
  configSchema: labConfigSchema,
  events: {
    "lab.report_ready": async (p, { now }) => {
      const order = await LabOrderModel.findById(p.labOrderId).select("priority").lean<any>();
      return [
        {
          dedupeKey: `lab:${p.labOrderId}:ready`,
          scopeType: "lab_order",
          scopeId: p.labOrderId,
          scheduledFor: now,
          patientId: p.patientId,
          urgent: order?.priority === "urgent",
        },
      ];
    },
  },
  // Safety net: reports verified in the last 24 hours that have no job yet
  async plan({ now }) {
    const orders = await LabOrderModel.find({ status: "ready", verifiedAt: { $gte: addMinutes(now, -24 * 60) } })
      .select("patient priority")
      .lean<any[]>();
    return orders.map((o) => ({
      dedupeKey: `lab:${o._id}:ready`,
      scopeType: "lab_order" as const,
      scopeId: String(o._id),
      scheduledFor: now,
      patientId: String(o.patient),
      urgent: o.priority === "urgent",
    }));
  },
  async prepare(job, { config, settings }) {
    const order = await LabOrderModel.findById(job.scopeId).select("status patient visit tests.name").lean<any>();
    if (!order) return fail("Lab order not found");
    if (order.status === "delivered") return fail("Report already collected");
    if (order.status !== "ready") return fail("Report is no longer verified");
    return labPatient(order, settings, {
      testNames: (order.tests ?? []).map((t: any) => t.name).join(", "),
      labHours: config.labHours,
    });
  },
} satisfies RuleDefinition<LabConfig>);

// ------------------------------------------------------------------ 7. lab sample reminder

type SampleConfig = LabConfig & { hoursAfter: number };

export const labSampleReminder = registerRule({
  key: "lab_sample_reminder",
  title: "Lab sample reminder",
  description:
    "If tests were ordered but no sample was collected after N hours (default 24), a reminder with directions to the lab.",
  trigger: "hourly planner",
  category: "labReports",
  countsTowardPhoneCap: true,
  enabledByDefault: true,
  cadenceMinutes: 60,
  defaults: {
    hoursAfter: 24,
    labHours: "8:00 AM – 8:00 PM",
    labLocation: "Ground floor, lab counter",
    quietHoursOverride: false,
    dailyLimit: 500,
    channels: ["whatsapp", "sms"],
    templateKey: "lab_sample_reminder",
  },
  configSchema: labConfigSchema
    .extend({
      hoursAfter: z
        .number()
        .int()
        .min(1)
        .max(14 * 24),
    })
    .partial(),
  async plan({ now, config }) {
    const orders = await LabOrderModel.find({
      status: "ordered",
      createdAt: { $lte: addMinutes(now, -config.hoursAfter * 60), $gte: addMinutes(now, -7 * 24 * 60) },
    })
      .select("patient createdAt")
      .lean<any[]>();
    return orders.map((o) => ({
      dedupeKey: `lab:${o._id}:sample`,
      scopeType: "lab_order" as const,
      scopeId: String(o._id),
      scheduledFor: addMinutes(o.createdAt, config.hoursAfter * 60),
      patientId: String(o.patient),
    }));
  },
  async prepare(job, { config, settings }) {
    if (!Types.ObjectId.isValid(job.scopeId)) return fail("Lab order not found");
    const order = await LabOrderModel.findById(job.scopeId).select("status patient visit").lean<any>();
    if (!order) return fail("Lab order not found");
    if (order.status !== "ordered") return fail("Sample already collected");
    return labPatient(order, settings, { labHours: config.labHours, labLocation: config.labLocation });
  },
} satisfies RuleDefinition<SampleConfig>);
