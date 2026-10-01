/* eslint-disable @typescript-eslint/no-explicit-any */
import { Types } from "mongoose";
import { setWhatsAppTransport } from "../../src/modules/assistant/channels/whatsapp/client";
import { ConversationModel } from "../../src/modules/assistant/conversation.model";
import { LabOrderModel } from "../../src/modules/clinical/lab/labOrder.model";
import { VisitModel } from "../../src/modules/clinical/visits/visit.model";
import { AppointmentModel } from "../../src/modules/hospital/appointment/appointment.model";
import { DoctorModel } from "../../src/modules/hospital/doctor/doctor.model";
import { HospitalSettingsModel } from "../../src/modules/hospital/settings/settings.model";
import { clearSettingsCache } from "../../src/modules/hospital/settings/settings.service";
import { PatientModel } from "../../src/modules/patients/patient.model";
import { claimJob, dispatchDue, processJob } from "../../src/modules/automation/dispatcher";
import { handleRuleEvent, runPlanner } from "../../src/modules/automation/engine";
import { AutomationJobModel } from "../../src/modules/automation/models/job.model";
import { OutboxMessageModel } from "../../src/modules/automation/models/outbox.model";
import { getRule } from "../../src/modules/automation/rules/registry";
import { ensureDefaultTemplates } from "../../src/modules/automation/templates/template.service";
import { addMinutes, atDhaka, dhakaDate } from "../../src/modules/automation/time";
import { addDays } from "../../src/utils/date";
import { createAppointment, createClinic, createPatients } from "../fixtures";
import { useTestDatabase } from "../helpers";

const rule = (key: string) => getRule(key)!;
const NOW = () => new Date();
const TODAY = () => dhakaDate(new Date());

/** Bypass mongoose timestamps: "this booking was made two days ago" */
const ageAppointment = (id: unknown) =>
  AppointmentModel.collection.updateOne(
    { _id: id as Types.ObjectId },
    { $set: { createdAt: new Date(Date.now() - 2 * 864e5) } },
  );

const jobs = (ruleKey: string) => AutomationJobModel.find({ ruleKey }).sort({ createdAt: 1 });

/** Send one specific job at a given moment */
const sendJob = async (id: unknown, at: Date) => {
  await AutomationJobModel.updateOne({ _id: id }, { $set: { status: "ready", scheduledFor: at } });
  const job = await claimJob(at, "test", id);
  return processJob(job!, at);
};

describe("automation rules", () => {
  useTestDatabase();
  let clinic: Awaited<ReturnType<typeof createClinic>>;
  let patient: any;

  beforeEach(async () => {
    setWhatsAppTransport({ name: "meta", send: async () => ({ ok: true, messageId: `wamid.T.${Math.random()}` }) });
    clinic = await createClinic();
    [patient] = await createPatients(1);
    await AutomationJobModel.init();
    await ensureDefaultTemplates();
    await HospitalSettingsModel.updateOne(
      { key: "default" },
      { $set: { quietHoursStart: "00:00", quietHoursEnd: "00:00", simulateWhatsApp: true, dedupeWindowMinutes: 0 } },
    );
    clearSettingsCache();
  });
  afterEach(() => setWhatsAppTransport(null));

  const book = (date: string, slotTime = "10:00", status = "booked", extra: Record<string, unknown> = {}) =>
    createAppointment({ patient, doctor: clinic.doctor, date, slotTime, status }).then(async (a) => {
      if (Object.keys(extra).length) await AppointmentModel.updateOne({ _id: a._id }, { $set: extra });
      return a;
    });

  // ---------------------------------------------------------------- 1
  it("confirmation: one job per booking, sent with the appointment details and action buttons", async () => {
    const a = await book(addDays(TODAY(), 1));
    const payload = {
      appointmentId: String(a._id),
      patientId: String(patient._id),
      doctorId: String(clinic.doctor._id),
      date: a.date,
      slotTime: a.slotTime,
      source: "reception",
    };
    expect((await handleRuleEvent(rule("appointment_confirmation"), "appointment.booked", payload)).created).toBe(1);
    expect((await handleRuleEvent(rule("appointment_confirmation"), "appointment.booked", payload)).created).toBe(0);
    expect(await dispatchDue(NOW())).toMatchObject({ sent: 1 });
    const row = await OutboxMessageModel.findOne({ ruleKey: "appointment_confirmation" });
    expect(row!.renderedText).toContain("Test Doctor");
    expect(row!.renderedText).toContain("১০১"); // room in Bangla numerals
    expect(row!.interactive!.buttons.map((b) => b.id)).toEqual([
      `auto|confirm|${a._id}`,
      `auto|reschedule|${a._id}`,
      `auto|cancel|${a._id}`,
    ]);
  });

  it("confirmation: walk-ins get the short welcome without buttons", async () => {
    const a = await book(TODAY(), "09:00", "checked_in", { source: "walk_in" });
    await handleRuleEvent(rule("appointment_confirmation"), "appointment.booked", {
      appointmentId: String(a._id),
      patientId: String(patient._id),
      doctorId: String(clinic.doctor._id),
      date: a.date,
      slotTime: a.slotTime,
      source: "walk_in",
    });
    await dispatchDue(NOW());
    const row = await OutboxMessageModel.findOne({ ruleKey: "appointment_confirmation" });
    expect(row).toMatchObject({ templateKey: "walk_in_welcome", interactive: null });
  });

  // ---------------------------------------------------------------- 2
  it("day-before: planned for 18:00 the evening before, idempotent, superseded on reschedule, stamps the appointment", async () => {
    const tomorrow = addDays(TODAY(), 1);
    const a = await book(tomorrow);
    await ageAppointment(a._id);
    const r = rule("reminder_day_before");
    expect((await runPlanner(r)).created).toBe(1);
    expect((await runPlanner(r)).created).toBe(0);
    const [job] = await jobs(r.key);
    expect(job.dedupeKey).toBe(`apt:${a._id}:T-1d`);
    expect(job.scheduledFor).toEqual(atDhaka(TODAY(), "18:00"));

    // Rescheduled to another slot tomorrow: the old job is superseded by the new one
    await AppointmentModel.updateOne({ _id: a._id }, { $set: { status: "cancelled", holdsSlot: false } });
    const b = await book(tomorrow, "11:00", "booked");
    await handleRuleEvent(r, "appointment.rescheduled", {
      fromAppointmentId: String(a._id),
      toAppointmentId: String(b._id),
      patientId: String(patient._id),
      doctorId: String(clinic.doctor._id),
      date: tomorrow,
      slotTime: "11:00",
    });
    const [oldJob, newJob] = await jobs(r.key);
    expect(oldJob).toMatchObject({ status: "superseded" });
    expect(String(oldJob.supersededBy)).toBe(String(newJob._id));

    expect(await sendJob(newJob._id, NOW())).toBe("sent");
    expect((await AppointmentModel.findById(b._id))!.lastReminderSentAt).toBeTruthy();
  });

  // ---------------------------------------------------------------- 3
  it("same-day: 90 minutes before the slot; checking in cancels it", async () => {
    const r = rule("reminder_same_day");
    const morning = atDhaka(TODAY(), "07:00");
    const a = await book(TODAY(), "11:00");
    await ageAppointment(a._id);
    expect((await runPlanner(r, morning)).created).toBe(1);
    const [job] = await jobs(r.key);
    expect(job.scheduledFor).toEqual(atDhaka(TODAY(), "09:30"));

    await handleRuleEvent(r, "appointment.checked_in", {
      appointmentId: String(a._id),
      patientId: String(patient._id),
      doctorId: String(clinic.doctor._id),
      date: TODAY(),
    });
    expect((await AutomationJobModel.findById(job._id))!.status).toBe("cancelled");
  });

  it("same-day: precondition at send time — a patient already checked in gets nothing", async () => {
    const r = rule("reminder_same_day");
    const a = await book(TODAY(), "11:00");
    await ageAppointment(a._id);
    await runPlanner(r, atDhaka(TODAY(), "07:00"));
    await AppointmentModel.updateOne({ _id: a._id }, { $set: { status: "checked_in" } });
    const [job] = await jobs(r.key);
    expect(await sendJob(job._id, atDhaka(TODAY(), "09:30"))).toBe("cancelled");
    expect((await AutomationJobModel.findById(job._id))!.cancelReason).toBe("Patient already checked in");
  });

  // ---------------------------------------------------------------- 4
  it("no-show: delayed offer, dropped if the patient already rebooked", async () => {
    const r = rule("no_show_rebook");
    const a = await book(TODAY(), "09:00", "no_show");
    const now = NOW();
    await handleRuleEvent(
      r,
      "appointment.no_show",
      {
        appointmentId: String(a._id),
        patientId: String(patient._id),
        doctorId: String(clinic.doctor._id),
        date: a.date,
      },
      now,
    );
    const [job] = await jobs(r.key);
    expect(job.scheduledFor).toEqual(addMinutes(now, 180));

    await book(addDays(TODAY(), 2), "10:00", "booked");
    expect(await sendJob(job._id, NOW())).toBe("cancelled");
    expect((await AutomationJobModel.findById(job._id))!.cancelReason).toBe("Patient already booked again");
  });

  // ---------------------------------------------------------------- 5
  it("follow-up: 3 days before at 10:00, cancelled when that doctor is already booked near the date", async () => {
    const r = rule("follow_up_reminder");
    const appt = await book(TODAY(), "09:00", "completed");
    const followUpDate = addDays(TODAY(), 5);
    const visit = await VisitModel.create({
      appointment: appt._id,
      patient: patient._id,
      doctor: clinic.doctor._id,
      date: TODAY(),
      status: "closed",
      openedAt: new Date(),
      closedAt: new Date(),
      followUp: { date: followUpDate },
    });
    const payload = {
      visitId: String(visit._id),
      appointmentId: String(appt._id),
      patientId: String(patient._id),
      doctorId: String(clinic.doctor._id),
      date: TODAY(),
      followUpDate,
    };
    await handleRuleEvent(r, "visit.closed", payload);
    expect((await runPlanner(r, atDhaka(addDays(TODAY(), 2), "08:00"))).created).toBe(0); // same dedupe key
    const [job] = await jobs(r.key);
    expect(job).toMatchObject({
      dedupeKey: `fup:${visit._id}:D-3`,
      scheduledFor: atDhaka(addDays(TODAY(), 2), "10:00"),
    });

    await book(addDays(followUpDate, 1), "10:00", "booked");
    expect(await sendJob(job._id, NOW())).toBe("cancelled");
    expect((await AutomationJobModel.findById(job._id))!.cancelReason).toBe("Follow-up already booked");
  });

  // ---------------------------------------------------------------- 6
  const labOrder = (status: string, extra: Record<string, unknown> = {}) =>
    LabOrderModel.create({
      orderNo: `LAB-${Math.random().toString(36).slice(2, 8)}`,
      patient: patient._id,
      date: TODAY(),
      status,
      orderedBy: new Types.ObjectId(),
      tests: [
        {
          labTest: new Types.ObjectId(),
          name: "Complete Blood Count",
          code: "CBC",
          results: [{ name: "Haemoglobin", value: "13.7", unit: "g/dL" }],
        },
      ],
      ...extra,
    });

  it("lab report ready: names the tests, NEVER the results; urgent orders may pass quiet hours", async () => {
    const r = rule("lab_report_ready");
    const order = await labOrder("ready", { priority: "urgent", verifiedAt: new Date() });
    await handleRuleEvent(r, "lab.report_ready", {
      labOrderId: String(order._id),
      patientId: String(patient._id),
      doctorId: null,
      visitId: null,
    });
    const [job] = await jobs(r.key);
    expect(job.urgent).toBe(true);
    await HospitalSettingsModel.updateOne(
      { key: "default" },
      { $set: { quietHoursStart: "21:00", quietHoursEnd: "09:00" } },
    );
    clearSettingsCache();
    expect(await sendJob(job._id, atDhaka(TODAY(), "23:00"))).toBe("sent");
    const row = await OutboxMessageModel.findOne({ ruleKey: r.key });
    expect(row!.renderedText).toContain("Complete Blood Count");
    expect(row!.renderedText).not.toMatch(/13\.7|১৩\.৭|Haemoglobin/);
  });

  it("lab report ready: an already collected report is not announced", async () => {
    const r = rule("lab_report_ready");
    const order = await labOrder("delivered", { verifiedAt: new Date() });
    await handleRuleEvent(r, "lab.report_ready", {
      labOrderId: String(order._id),
      patientId: String(patient._id),
      doctorId: null,
      visitId: null,
    });
    expect(await dispatchDue(NOW())).toMatchObject({ cancelled: 1 });
  });

  // ---------------------------------------------------------------- 7
  it("lab sample reminder: only for orders still waiting for a sample after 24 hours", async () => {
    const r = rule("lab_sample_reminder");
    const old = await labOrder("ordered");
    const fresh = await labOrder("ordered");
    await LabOrderModel.collection.updateOne(
      { _id: old._id },
      { $set: { createdAt: new Date(Date.now() - 30 * 3600e3) } },
    );
    await LabOrderModel.collection.updateOne({ _id: fresh._id }, { $set: { createdAt: new Date() } });
    expect((await runPlanner(r)).created).toBe(1);
    await LabOrderModel.updateOne({ _id: old._id }, { $set: { status: "sample_collected" } });
    expect(await dispatchDue(NOW())).toMatchObject({ cancelled: 1 });
  });

  // ---------------------------------------------------------------- 8
  it("chat no-reply: staff alert after 20 min, courteous patient message after 45, none once staff replied", async () => {
    const r = rule("chat_no_reply");
    const conv = await ConversationModel.create({
      channel: "web",
      channelUserId: "c3".repeat(16),
      status: "needs_human",
      handoverAt: new Date(Date.now() - 50 * 60_000),
      handoverReason: "Patient asked for a person",
      lastInboundAt: new Date(Date.now() - 50 * 60_000),
    });
    expect((await runPlanner(r)).created).toBe(2);
    expect(await dispatchDue(NOW())).toMatchObject({ sent: 2 });
    const rows = await OutboxMessageModel.find({ ruleKey: r.key });
    expect(rows.map((x) => x.channel).sort()).toEqual(["inapp", "web"]);

    await ConversationModel.updateOne(
      { _id: conv._id },
      { $set: { handoverAt: new Date(Date.now() - 30 * 60_000), lastStaffReplyAt: new Date() } },
    );
    expect((await runPlanner(r)).created).toBe(0);
  });

  // ---------------------------------------------------------------- 9
  it("doctor absence: flags the bookings and tells the patients — even after STOP (essential)", async () => {
    const r = rule("doctor_absence");
    const tomorrow = addDays(TODAY(), 1);
    const a = await book(tomorrow);
    await PatientModel.updateOne({ _id: patient._id }, { $set: { "preferences.optOutAll": true } });
    await DoctorModel.updateOne(
      { _id: clinic.doctor._id },
      { $push: { leaves: { from: tomorrow, to: tomorrow, reason: "Conference" } } },
    );
    await handleRuleEvent(r, "doctor.leave_added", {
      doctorId: String(clinic.doctor._id),
      from: tomorrow,
      to: tomorrow,
    });
    expect((await AppointmentModel.findById(a._id))!.doctorAbsent).toBe(true);
    expect(await dispatchDue(NOW())).toMatchObject({ sent: 1 });
    expect((await AppointmentModel.findById(a._id))!.doctorAbsentNotifiedAt).toBeTruthy();
  });

  // ---------------------------------------------------------------- 10, 11
  it("daily digest: one job per day at 21:30 with plain counts for management", async () => {
    const r = rule("daily_digest");
    await book(TODAY(), "09:00", "completed");
    await book(TODAY(), "09:10", "no_show", { patient: (await createPatients(1))[0]._id, serialNo: 2 });
    expect((await runPlanner(r)).created).toBe(1);
    expect((await runPlanner(r)).created).toBe(0);
    const [job] = await jobs(r.key);
    expect(job.scheduledFor).toEqual(atDhaka(TODAY(), "21:30"));
    expect(await sendJob(job._id, NOW())).toBe("sent");
    const row = await OutboxMessageModel.findOne({ ruleKey: r.key });
    expect(row).toMatchObject({ channel: "inapp", toRef: "perm:report:operations" });
    expect(row!.variables).toMatchObject({ appointments: "2", completed: "1", noShows: "1" });
  });

  it("birthday greeting is off by default and only plans for opted-in patients", async () => {
    const r = rule("birthday_greeting");
    const [m, d] = TODAY().slice(5).split("-");
    await PatientModel.updateOne(
      { _id: patient._id },
      { $set: { dateOfBirth: new Date(`1990-${m}-${d}`), dobEstimated: false, "preferences.marketing": true } },
    );
    const [other] = await createPatients(1);
    await PatientModel.updateOne(
      { _id: other._id },
      { $set: { dateOfBirth: new Date(`1985-${m}-${d}`), dobEstimated: false } },
    );
    expect((await runPlanner(r)).skipped).toBe("disabled");
    const preview = await runPlanner(r, NOW(), { dryRun: true });
    expect(preview.planned.map((j) => j.patientId)).toEqual([String(patient._id)]);
  });
});
