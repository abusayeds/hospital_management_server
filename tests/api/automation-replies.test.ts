/* eslint-disable @typescript-eslint/no-explicit-any */
import { setAiProvider } from "../../src/ai/ai.service";
import { drainEvents } from "../../src/events/bus";
import { processWebhook } from "../../src/modules/assistant/channels/whatsapp/adapter";
import { ChatMessageModel } from "../../src/modules/assistant/chatMessage.model";
import { AppointmentModel } from "../../src/modules/hospital/appointment/appointment.model";
import { HospitalSettingsModel } from "../../src/modules/hospital/settings/settings.model";
import { clearSettingsCache } from "../../src/modules/hospital/settings/settings.service";
import { PatientModel } from "../../src/modules/patients/patient.model";
import { dispatchDue } from "../../src/modules/automation/dispatcher";
import { handleRuleEvent, runPlanner } from "../../src/modules/automation/engine";
import { AutomationJobModel } from "../../src/modules/automation/models/job.model";
import { OutboxMessageModel } from "../../src/modules/automation/models/outbox.model";
import { getRule } from "../../src/modules/automation/rules/registry";
import { ensureDefaultTemplates } from "../../src/modules/automation/templates/template.service";
import { addDays, todayInDhaka } from "../../src/utils/date";
import { scriptedProvider } from "../assistant-fakes";
import { createAppointment, createClinic, createPatients } from "../fixtures";
import { useTestDatabase } from "../helpers";

let n = 0;
let WA = "";

/** One inbound WhatsApp message (simulator path = the real adapter + engine); returns the replies */
const inbound = async (m: { text?: string; replyId?: string; title?: string; id?: string }) => {
  const started = new Date(Date.now() - 1);
  const id = m.id ?? `wamid.IN.${++n}`;
  const message = m.replyId
    ? {
        from: WA,
        id,
        type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: m.replyId, title: m.title ?? "" } },
      }
    : { from: WA, id, type: "text", text: { body: m.text } };
  await processWebhook(
    { entry: [{ changes: [{ value: { contacts: [{ wa_id: WA }], messages: [message] } }] }] },
    { simulated: true },
  );
  return ChatMessageModel.find({ direction: "outbound", sender: { $ne: "automation" }, createdAt: { $gte: started } })
    .sort({ createdAt: 1 })
    .lean<any[]>();
};

const optionIds = (msgs: any[]) =>
  msgs.flatMap((m) =>
    [...(m.rich?.items ?? []), ...(m.rich?.options ?? []), ...(m.rich?.actions ?? [])].map((o: any) => o.id),
  );

describe("replies to automated messages", () => {
  useTestDatabase();
  let clinic: Awaited<ReturnType<typeof createClinic>>;
  let patient: any;
  let appt: any;

  beforeEach(async () => {
    clinic = await createClinic();
    [patient] = await createPatients(1);
    WA = patient.phone.replace("+", "");
    await ensureDefaultTemplates();
    await HospitalSettingsModel.updateOne(
      { key: "default" },
      { $set: { quietHoursStart: "00:00", quietHoursEnd: "00:00", simulateWhatsApp: true, dedupeWindowMinutes: 0 } },
    );
    clearSettingsCache();
    appt = await createAppointment({
      patient,
      doctor: clinic.doctor,
      date: addDays(todayInDhaka(), 2),
      slotTime: "10:00",
      status: "booked",
    });
    // The confirmation goes out first (outside the 24h window → template with buttons)
    await handleRuleEvent(getRule("appointment_confirmation")!, "appointment.booked", {
      appointmentId: String(appt._id),
      patientId: String(patient._id),
      doctorId: String(clinic.doctor._id),
      date: appt.date,
      slotTime: appt.slotTime,
      source: "reception",
    });
    await dispatchDue();
  });
  afterEach(async () => {
    setAiProvider(undefined);
    await drainEvents(); // let event handlers of this test finish before the next one starts
  });

  it("the automated message lands in the patient's WhatsApp conversation", async () => {
    const msgs = await ChatMessageModel.find({ sender: "automation" }).lean<any[]>();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].channelPayload[0].type).toBe("template");
  });

  it("Confirm marks the appointment confirmed by the patient", async () => {
    const replies = await inbound({ replyId: `auto|confirm|${appt._id}`, title: "Confirm" });
    expect(replies[0].text).toMatch(/ধন্যবাদ/);
    const a = await AppointmentModel.findById(appt._id);
    expect(a).toMatchObject({ confirmedByPatient: true });
    expect(await OutboxMessageModel.findOne({ ruleKey: "appointment_confirmation" })).toMatchObject({
      replyAction: "confirm",
    });
  });

  it("Cancel opens the chatbot's confirm step, then cancels through the existing service and offers new times", async () => {
    const summary = await inbound({ replyId: `auto|cancel|${appt._id}`, title: "Cancel" });
    expect(summary[0].rich.kind).toBe("cancel_summary");
    expect((await AppointmentModel.findById(appt._id))!.status).toBe("booked"); // not yet

    const confirmId = optionIds(summary).find((id) => id.startsWith("confirm|"))!;
    const done = await inbound({ replyId: confirmId, title: "Confirm" });
    expect(done[0].rich.kind).toBe("cancel_success");
    expect(optionIds(done)).toContain(`auto|rebook|${appt._id}`);
    const a = await AppointmentModel.findById(appt._id);
    expect(a).toMatchObject({ status: "cancelled", cancelReason: "Cancelled by the patient via the assistant" });

    const times = await inbound({ replyId: `auto|rebook|${appt._id}`, title: "New time" });
    expect(optionIds(times)[0]).toMatch(new RegExp(`^slot\\|${clinic.doctor._id}\\|`));
  });

  it("a typed answer ('বাতিল') to the last automated message works like the button", async () => {
    const replies = await inbound({ text: "বাতিল" });
    expect(replies[0].rich.kind).toBe("cancel_summary");
  });

  it("Reschedule offers the same doctor's free times and moves the appointment after Confirm", async () => {
    const list = await inbound({ replyId: `auto|reschedule|${appt._id}`, title: "Reschedule" });
    const moveId = optionIds(list).find((id) => id.startsWith(`auto|move|${appt._id}|`) && !id.includes(appt.date))!;
    expect(moveId).toBeTruthy();
    const summary = await inbound({ replyId: moveId, title: "time" });
    expect(summary[0].rich.kind).toBe("reschedule_summary");
    await inbound({ replyId: optionIds(summary).find((id) => id.startsWith("confirm|"))!, title: "Confirm" });
    const old = await AppointmentModel.findById(appt._id);
    expect(old!.status).toBe("cancelled");
    expect(old!.rescheduledTo).toBeTruthy();
  });

  it("STOP opts out: reminders are skipped, essential messages still go; START opts back in", async () => {
    const replies = await inbound({ text: "STOP" });
    expect(replies[0].text).toMatch(/START/);
    expect((await PatientModel.findById(patient._id))!.preferences.optOutAll).toBe(true);

    // A reminder for an appointment tomorrow is now skipped with the reason
    const tomorrowAppt = await createAppointment({
      patient,
      doctor: clinic.doctor,
      date: addDays(todayInDhaka(), 1),
      slotTime: "11:00",
      status: "booked",
      serialNo: 2,
    });
    await AppointmentModel.collection.updateOne(
      { _id: tomorrowAppt._id },
      { $set: { createdAt: new Date(Date.now() - 2 * 864e5) } },
    );
    await runPlanner(getRule("reminder_day_before")!);
    await AutomationJobModel.updateMany(
      { ruleKey: "reminder_day_before" },
      { $set: { scheduledFor: new Date(Date.now() - 1000) } },
    );
    expect(await dispatchDue()).toMatchObject({ skipped: 1 });
    expect(
      (await AutomationJobModel.findOne({ scopeId: String(tomorrowAppt._id) }).lean<any>()).decisions.at(-1),
    ).toMatchObject({
      reason: "optOut",
    });

    await inbound({ text: "start" });
    expect((await PatientModel.findById(patient._id))!.preferences.optOutAll).toBe(false);
  });

  it("someone else's appointment id in a button is refused", async () => {
    const [other] = await createPatients(1);
    const theirs = await createAppointment({
      patient: other,
      doctor: clinic.doctor,
      date: addDays(todayInDhaka(), 3),
      status: "booked",
    });
    const replies = await inbound({ replyId: `auto|cancel|${theirs._id}`, title: "Cancel" });
    expect(replies[0].text).toMatch(/does not belong/);
    expect((await AppointmentModel.findById(theirs._id))!.status).toBe("booked");
  });

  it("free text continues in the normal chatbot", async () => {
    const fake = scriptedProvider([() => ({ text: "আমাদের হাসপাতাল সকাল ৯টা থেকে খোলা।" })]);
    setAiProvider(fake.provider);
    const replies = await inbound({ text: "হাসপাতাল কখন খোলে?" });
    expect(replies[0].text).toContain("সকাল ৯টা");
    expect(fake.calls.length).toBe(1);
  });

  it("a WhatsApp retry of the same reply is processed once", async () => {
    await inbound({ id: "wamid.SAME", replyId: `auto|confirm|${appt._id}`, title: "Confirm" });
    const again = await inbound({ id: "wamid.SAME", replyId: `auto|confirm|${appt._id}`, title: "Confirm" });
    expect(again).toHaveLength(0);
    expect(await ChatMessageModel.countDocuments({ direction: "outbound", sender: "bot" })).toBe(1);
  });
});
