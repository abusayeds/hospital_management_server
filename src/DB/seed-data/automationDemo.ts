/* eslint-disable @typescript-eslint/no-explicit-any */
import { LabOrderModel } from "../../modules/clinical/lab/labOrder.model";
import { VisitModel } from "../../modules/clinical/visits/visit.model";
import { AppointmentModel } from "../../modules/hospital/appointment/appointment.model";
import { LabTestModel } from "../../modules/hospital/catalog/catalog.models";
import { DoctorModel } from "../../modules/hospital/doctor/doctor.model";
import { PatientModel } from "../../modules/patients/patient.model";
import { UserModel } from "../../modules/users/user.model";
import { planJobs } from "../../modules/automation/jobs";
import { AutomationJobModel } from "../../modules/automation/models/job.model";
import { OutboxMessageModel } from "../../modules/automation/models/outbox.model";
import { AutomationRuleSettingModel } from "../../modules/automation/models/ruleSetting.model";
import "../../modules/automation/rules";
import { allRules } from "../../modules/automation/rules/registry";
import { ensureDefaultTemplates } from "../../modules/automation/templates/template.service";
import { addMinutes, dhakaDate, dhakaMinutes } from "../../modules/automation/time";
import { nextCode } from "../../models/counter.model";
import { addDays, toHHMM } from "../../utils/date";
import { logger } from "../../utils/logger";

/**
 * AUTOMATION DEMO — so the first minutes after `npm run dev` already show the engine working (all in
 * SIMULATION mode, nothing reaches a real phone). One easy-to-remember demo patient carries the story:
 *   phone 01711-000001 → open Admin → WhatsApp Simulator with that number to see and answer the messages
 *   - an appointment later today      → same-day reminder within minutes
 *   - an appointment tomorrow         → booking confirmation now, day-before reminder at 18:00
 *   - a visit with follow-up in 3 days → follow-up reminder
 *   - a lab report verified just now  → report-ready message
 *   - a no-show yesterday             → rebook offer
 * Plus a few days of Outbox history and one failed send to practise "Retry". Runs once.
 */

const DEMO_PHONE = "+8801711000001";

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);

/** Insert an appointment at the first free 10-minute slot from `slotTime` (direct insert, demo only) */
const insertAppointment = async (a: {
  patient: any;
  doctor: any;
  date: string;
  slotTime: string;
  status: string;
  createdAt?: Date;
}) => {
  const [h, m] = a.slotTime.split(":").map(Number);
  for (let t = h * 60 + m; t < 24 * 60; t += 10) {
    try {
      const status = a.status;
      const doc = await AppointmentModel.create({
        patient: a.patient._id,
        doctor: a.doctor._id,
        department: a.doctor.department,
        date: a.date,
        slotTime: toHHMM(t),
        sessionKey: `${toHHMM(t)}-${toHHMM(Math.min(t + 60, 24 * 60 - 1))}`,
        serialNo: 50 + (Math.floor(t / 10) % 40),
        feeSnapshot: a.doctor.consultationFee ?? 80000,
        source: "reception",
        status,
        holdsSlot: ["booked", "checked_in", "in_consultation"].includes(status),
        statusHistory: [{ status, at: a.createdAt ?? new Date() }],
      });
      // Booked two days ago (planners skip bookings made a moment ago — the confirmation covers those)
      await AppointmentModel.collection.updateOne(
        { _id: doc._id },
        { $set: { createdAt: a.createdAt ?? ago(2 * 24 * 60) } },
      );
      return doc;
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }
  return null;
};

export const seedAutomationDemo = async () => {
  await ensureDefaultTemplates();
  // Every rule gets an explicit row (enabled as by default: all on, birthday greeting off)
  for (const rule of allRules())
    await AutomationRuleSettingModel.updateOne(
      { key: rule.key },
      { $setOnInsert: { key: rule.key, enabled: rule.enabledByDefault, config: {} } },
      { upsert: true },
    );
  if (await OutboxMessageModel.exists({ source: "automation" })) return;

  const doctors = await DoctorModel.find({ isActive: true }).limit(3).lean<any[]>();
  if (doctors.length < 2) return void logger.warn("Automation demo skipped: seed doctors first");
  const [docA, docB] = doctors;
  const doctorUser = await UserModel.findOne({ role: "doctor" }).lean<any>();

  let patient = await PatientModel.findOne({ phone: DEMO_PHONE }).lean<any>();
  if (!patient)
    patient = (
      await PatientModel.create({
        patientCode: await nextCode("patient", "TL"),
        name: "Rahim Uddin",
        nameBn: "রহিম উদ্দিন",
        nameKey: "rahim uddin",
        gender: "male",
        dateOfBirth: new Date("1984-03-12"),
        phone: DEMO_PHONE,
        registrationSource: "reception",
        notes: "Demo patient for the automation engine (simulated messages only).",
      })
    ).toObject();

  const now = new Date();
  const today = dhakaDate(now);
  const tomorrow = addDays(today, 1);
  const yesterday = addDays(today, -1);

  // Later today: slot ~95 minutes from now → same-day reminder is due in about 5 minutes
  const slot = Math.ceil((dhakaMinutes(now) + 95) / 10) * 10;
  if (slot < 23 * 60 + 50)
    await insertAppointment({ patient, doctor: docA, date: today, slotTime: toHHMM(slot), status: "booked" });

  // Tomorrow: confirmation goes out right away, the day-before reminder at 18:00
  const tomorrowAppt = await insertAppointment({
    patient,
    doctor: docB,
    date: tomorrow,
    slotTime: "10:00",
    status: "booked",
  });
  if (tomorrowAppt)
    await planJobs("appointment_confirmation", [
      {
        dedupeKey: `apt:${tomorrowAppt._id}:confirm`,
        scopeType: "appointment",
        scopeId: String(tomorrowAppt._id),
        scheduledFor: now,
        patientId: String(patient._id),
        data: { source: "reception" },
      },
    ]);

  // Yesterday: a no-show → rebook offer in a couple of minutes
  const missed = await insertAppointment({
    patient,
    doctor: docB,
    date: yesterday,
    slotTime: "11:00",
    status: "no_show",
  });
  if (missed)
    await planJobs("no_show_rebook", [
      {
        dedupeKey: `apt:${missed._id}:no-show`,
        scopeType: "appointment",
        scopeId: String(missed._id),
        scheduledFor: addMinutes(now, 2),
        patientId: String(patient._id),
        data: { doctorId: String(docB._id) },
      },
    ]);

  // A closed visit 4 days ago with a follow-up in 3 days → the follow-up planner reminds today
  const seen = await insertAppointment({
    patient,
    doctor: docA,
    date: addDays(today, -4),
    slotTime: "09:30",
    status: "completed",
  });
  if (seen && doctorUser) {
    const visit = await VisitModel.create({
      appointment: seen._id,
      patient: patient._id,
      doctor: docA._id,
      date: seen.date,
      status: "closed",
      chiefComplaints: [],
      followUp: { date: addDays(today, 3), note: "" },
      openedAt: ago(4 * 24 * 60),
      closedAt: ago(4 * 24 * 60 - 20),
      closedBy: doctorUser._id,
      createdBy: doctorUser._id,
    });

    // A report verified a few minutes ago → report-ready message on the next planner run
    const tests = await LabTestModel.find({ code: { $in: ["CBC", "LIPID"] } }).lean<any[]>();
    if (tests.length)
      await LabOrderModel.create({
        orderNo: await nextCode("lab_order", "LAB"),
        patient: patient._id,
        visit: visit._id,
        doctor: docA._id,
        date: today,
        status: "ready",
        tests: tests.map((t) => ({ labTest: t._id, name: t.name, code: t.code, results: [] })),
        orderedBy: doctorUser._id,
        verifiedAt: ago(10),
        history: [
          { status: "ordered", at: ago(180), by: doctorUser._id },
          { status: "ready", at: ago(10), note: "verified" },
        ],
        createdBy: doctorUser._id,
      });
  }

  // ---- a few days of Outbox history (simulated) + one failed send to practise "Retry"
  const others = await PatientModel.find({ phone: { $ne: DEMO_PHONE } })
    .limit(6)
    .lean<any[]>();
  const history = [
    { rule: "appointment_confirmation", tpl: "appointment_confirmation", status: "read", minutes: 3 * 24 * 60 },
    { rule: "reminder_day_before", tpl: "reminder_day_before", status: "read", minutes: 2 * 24 * 60 + 300 },
    { rule: "reminder_same_day", tpl: "reminder_same_day", status: "delivered", minutes: 2 * 24 * 60 },
    { rule: "lab_report_ready", tpl: "lab_report_ready", status: "read", minutes: 30 * 60 },
    { rule: "follow_up_reminder", tpl: "follow_up_reminder", status: "delivered", minutes: 26 * 60 },
    { rule: "no_show_rebook", tpl: "no_show_rebook", status: "sent", minutes: 20 * 60 },
  ];
  const TEXT: Record<string, string> = {
    appointment_confirmation: "আপনার সিরিয়াল নিশ্চিত হয়েছে ✅ (demo history)",
    reminder_day_before: "মনে করিয়ে দিচ্ছি: আগামীকাল আপনার অ্যাপয়েন্টমেন্ট। (demo history)",
    reminder_same_day: "আজ আপনার অ্যাপয়েন্টমেন্ট — ১৫ মিনিট আগে আসবেন। (demo history)",
    lab_report_ready: "আপনার রিপোর্ট তৈরি হয়েছে, ল্যাব কাউন্টার থেকে সংগ্রহ করুন। (demo history)",
    follow_up_reminder: "ডাক্তার ফলো-আপের পরামর্শ দিয়েছিলেন। সিরিয়াল নেবেন? (demo history)",
    no_show_rebook: "আজ আপনাকে পাইনি — নতুন সময় নিতে চান? (demo history)",
  };
  const rows = history.map((h, i) => {
    const p = others[i % Math.max(1, others.length)] ?? patient;
    const at = ago(h.minutes);
    const steps =
      h.status === "read" ? ["sent", "delivered", "read"] : h.status === "delivered" ? ["sent", "delivered"] : ["sent"];
    return {
      patient: p._id,
      toType: "patient",
      toRef: p.phone,
      channel: "whatsapp",
      source: "automation",
      messageKind: "template",
      templateKey: h.tpl,
      templateVersion: 1,
      whatsappTemplateName: `tl_${h.tpl}`,
      variables: {},
      renderedText: TEXT[h.rule],
      language: "bn",
      sentAt: at,
      status: h.status,
      providerMessageId: `wamid.SIM.demo${i}`,
      deliveryUpdates: steps.map((s, k) => ({ status: s, at: new Date(at.getTime() + k * 90_000) })),
      simulated: true,
      ruleKey: h.rule,
      createdAt: at,
      updatedAt: at,
    };
  });
  await OutboxMessageModel.collection.insertMany(rows as any[]);

  // A send that failed (Meta refused it, SMS fallback was off): tomorrow's day-before reminder. "Retry" in
  // the Outbox re-checks it and sends it (simulated) at once. Same dedupe key as the planner's job, so the
  // planner never adds a second one.
  if (!tomorrowAppt) return;
  const failedAt = ago(45);
  const failedJob = await AutomationJobModel.create({
    ruleKey: "reminder_day_before",
    dedupeKey: `apt:${tomorrowAppt._id}:T-1d`,
    scopeType: "appointment",
    scopeId: String(tomorrowAppt._id),
    data: { date: tomorrow },
    patient: patient._id,
    scheduledFor: failedAt,
    originalScheduledFor: failedAt,
    status: "failed",
    lastError: "(#131026) Message undeliverable (demo)",
    sendAttempts: [
      { at: failedAt, channel: "whatsapp", result: "failed", error: "(#131026) Message undeliverable (demo)" },
    ],
    decisions: [
      { at: failedAt, action: "failed", reason: "sendFailed", detail: "(#131026) Message undeliverable (demo)" },
    ],
  });
  const failedRow = await OutboxMessageModel.create({
    patient: patient._id,
    toType: "patient",
    toRef: patient.phone,
    channel: "whatsapp",
    source: "automation",
    messageKind: "template",
    templateKey: "reminder_day_before",
    templateVersion: 1,
    renderedText: "মনে করিয়ে দিচ্ছি, রহিম: আগামীকাল আপনার অ্যাপয়েন্টমেন্ট। (demo failure)",
    language: "bn",
    status: "failed",
    error: "(#131026) Message undeliverable (demo)",
    deliveryUpdates: [{ status: "failed", at: failedAt, error: "(#131026) Message undeliverable (demo)" }],
    simulated: true,
    ruleKey: "reminder_day_before",
    job: failedJob._id,
  });
  await AutomationJobModel.updateOne({ _id: failedJob._id }, { $set: { outboxMessage: failedRow._id } });

  logger.info(`Automation demo: patient ${DEMO_PHONE}, reminders planned, ${rows.length + 1} outbox history rows`);
};
