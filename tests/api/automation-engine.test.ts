import { z } from "zod";
import { setWhatsAppTransport, Transport } from "../../src/modules/assistant/channels/whatsapp/client";
import { ChatMessageModel } from "../../src/modules/assistant/chatMessage.model";
import { ConversationModel } from "../../src/modules/assistant/conversation.model";
import { HospitalSettingsModel } from "../../src/modules/hospital/settings/settings.model";
import { clearSettingsCache } from "../../src/modules/hospital/settings/settings.service";
import { PatientModel } from "../../src/modules/patients/patient.model";
import { claimJob, dispatchDue, processJob, retryJob } from "../../src/modules/automation/dispatcher";
import { setSmsProvider } from "../../src/modules/automation/outbox/sms";
import { planJobs } from "../../src/modules/automation/jobs";
import { AutomationJobModel } from "../../src/modules/automation/models/job.model";
import { OutboxMessageModel } from "../../src/modules/automation/models/outbox.model";
import { registerRule, unregisterRule } from "../../src/modules/automation/rules/registry";
import type { AnyRule } from "../../src/modules/automation/rules/types";
import { ensureDefaultTemplates } from "../../src/modules/automation/templates/template.service";
import { atDhaka, dhakaDate } from "../../src/modules/automation/time";
import { createPatients } from "../fixtures";
import { useTestDatabase } from "../helpers";

// A tiny rule driven by a fake "world": the dispatcher must re-check it at send time
const world = new Map<string, { valid: boolean }>();
const testRule: AnyRule = {
  key: "test_reminder",
  title: "Test reminder",
  description: "",
  trigger: "test",
  category: "reminders",
  countsTowardPhoneCap: true,
  enabledByDefault: true,
  defaults: {
    quietHoursOverride: true,
    dailyLimit: 100,
    channels: ["whatsapp", "sms"],
    templateKey: "reminder_day_before",
  },
  configSchema: z.object({}).partial(),
  prepare: async (job) => {
    if (!world.get(job.scopeId)?.valid) return { ok: false, reason: "Appointment is no longer booked" };
    return {
      ok: true,
      to: "patient",
      patientId: String(job.data.patientId),
      phone: String(job.data.phone),
      variables: {
        patientName: "Rahim",
        doctorName: "Dr. Test",
        date: "2026-10-02",
        time: "10:30",
        serial: String(job.data.serial ?? 1),
        room: "101",
        hospital: "Testolife",
      },
      related: { type: "appointment", id: job.scopeId },
    };
  },
};

const NOW = () => new Date();
let patient: Awaited<ReturnType<typeof createPatients>>[number];

const settings = async (patch: Record<string, unknown>) => {
  await HospitalSettingsModel.updateOne({ key: "default" }, { $set: patch });
  clearSettingsCache();
};

const DUE = new Date(Date.now() - 60_000); // fixed, like a real planner computing the same time again
const plan = (scopeId: string, extra: Record<string, unknown> = {}, at = DUE) =>
  planJobs(testRule.key, [
    {
      dedupeKey: `apt:${scopeId}:T-24h`,
      scopeType: "appointment",
      scopeId,
      scheduledFor: at,
      patientId: String(patient._id),
      data: { patientId: String(patient._id), phone: patient.phone, ...extra },
    },
  ]);

const sends: unknown[] = [];
const metaSpy: Transport = {
  name: "meta",
  send: async (payload) => {
    sends.push(payload);
    return { ok: true, messageId: `wamid.REAL.${sends.length}` };
  },
};

describe("automation engine", () => {
  useTestDatabase();

  beforeAll(() => registerRule(testRule));
  afterAll(() => unregisterRule(testRule.key));

  beforeEach(async () => {
    world.clear();
    sends.length = 0;
    setWhatsAppTransport(metaSpy);
    clearSettingsCache();
    await AutomationJobModel.init();
    await ensureDefaultTemplates();
    [patient] = await createPatients(1);
    // No quiet hours unless a test turns them on
    await HospitalSettingsModel.updateOne(
      { key: "default" },
      {
        $set: { quietHoursStart: "00:00", quietHoursEnd: "00:00" },
        $setOnInsert: {
          name: "Testolife",
          nameBn: "টেস্টোলাইফ",
          address: "Dhaka, Bangladesh",
          emergencyPhone: "999",
          openingHours: "9-9",
        },
      },
      { upsert: true },
    );
    clearSettingsCache();
  });
  afterEach(() => {
    setWhatsAppTransport(null);
    setSmsProvider(null);
  });

  it("planning is idempotent: the same dedupe key never creates a second job", async () => {
    expect(await plan("a1")).toEqual({ created: 1, updated: 0 });
    expect(await plan("a1")).toEqual({ created: 0, updated: 0 });
    await Promise.all([plan("a2"), plan("a2"), plan("a2")]);
    expect(await AutomationJobModel.countDocuments()).toBe(2);
    await expect(
      AutomationJobModel.create({
        ruleKey: testRule.key,
        dedupeKey: "apt:a1:T-24h",
        scopeType: "appointment",
        scopeId: "a1",
        scheduledFor: new Date(),
        originalScheduledFor: new Date(),
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it("the lease lets only one worker claim a job", async () => {
    world.set("a1", { valid: true });
    await plan("a1");
    await AutomationJobModel.updateMany({}, { $set: { status: "ready" } });
    const [first, second] = await Promise.all([claimJob(NOW(), "worker-A"), claimJob(NOW(), "worker-B")]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    const winner = (first ?? second)!;
    expect(winner.status).toBe("sending");
    expect(await processJob(winner, NOW())).toBe("sent");
    expect(sends).toHaveLength(1);
    expect(await OutboxMessageModel.countDocuments({ ruleKey: testRule.key })).toBe(1);
  });

  it("re-checks preconditions at send time: a cancelled appointment is never messaged", async () => {
    world.set("a1", { valid: true });
    await plan("a1");
    world.set("a1", { valid: false }); // cancelled after the reminder was planned
    expect(await dispatchDue(NOW())).toMatchObject({ cancelled: 1, sent: 0 });
    const job = await AutomationJobModel.findOne();
    expect(job).toMatchObject({ status: "cancelled", cancelReason: "Appointment is no longer booked" });
    expect(job!.decisions.at(-1)).toMatchObject({ action: "cancelled", reason: "preconditionFailed" });
    expect(sends).toHaveLength(0);
  });

  it("outside the 24-hour window sends the approved template; inside it a session message with buttons", async () => {
    world.set("a1", { valid: true });
    world.set("a2", { valid: true });
    await plan("a1");
    await dispatchDue(NOW());
    const template = sends[0] as {
      type: string;
      template: { name: string; components: { type: string; parameters: unknown[] }[] };
    };
    expect(template.type).toBe("template");
    expect(template.template.name).toBe("tl_reminder_day_before");
    expect(template.template.components[0].parameters).toHaveLength(5);
    expect(template.template.components.filter((c) => c.type === "button")).toHaveLength(3);

    // The patient writes → inside the window now
    await ConversationModel.updateOne({}, { $set: { lastInboundAt: new Date() } });
    await plan("a2", { serial: 2 });
    await dispatchDue(NOW());
    const session = sends[1] as { type: string; interactive: { action: { buttons: { reply: { id: string } }[] } } };
    expect(session.type).toBe("interactive");
    expect(session.interactive.action.buttons.map((b) => b.reply.id)).toEqual([
      "auto|confirm|a2",
      "auto|reschedule|a2",
      "auto|cancel|a2",
    ]);
    const rows = await OutboxMessageModel.find({ ruleKey: testRule.key }).sort({ createdAt: 1 });
    expect(rows.map((r) => r.messageKind)).toEqual(["template", "session"]);
    // The message lives in the patient's WhatsApp conversation, so replies land in the same chat
    expect(await ChatMessageModel.countDocuments({ sender: "automation" })).toBe(2);
  });

  it("quiet hours defer non-urgent jobs to the morning", async () => {
    world.set("a1", { valid: true });
    await settings({ quietHoursStart: "21:00", quietHoursEnd: "09:00" });
    const night = atDhaka(dhakaDate(new Date()), "23:00");
    await plan("a1", {}, new Date(night.getTime() - 60_000));
    expect(await dispatchDue(night)).toMatchObject({ deferred: 1 });
    const job = await AutomationJobModel.findOne();
    expect(job!.status).toBe("scheduled");
    expect(job!.scheduledFor.getTime()).toBeGreaterThan(night.getTime());
    expect(job!.decisions.at(-1)).toMatchObject({ action: "deferred", reason: "quietHours" });

    await AutomationJobModel.updateOne({}, { $set: { urgent: true, scheduledFor: night } });
    expect(await dispatchDue(night)).toMatchObject({ sent: 1 }); // urgent + rule allows override
  });

  it("per-phone daily cap and global budget defer (never drop) jobs", async () => {
    await settings({ perPhoneDailyCap: 2, dedupeWindowMinutes: 0 });
    for (const id of ["a1", "a2", "a3"]) {
      world.set(id, { valid: true });
      await plan(id, { serial: id.slice(1) });
    }
    expect(await dispatchDue(NOW())).toMatchObject({ sent: 2, deferred: 1 });
    const deferred = await AutomationJobModel.findOne({ status: "scheduled" });
    expect(deferred!.decisions.at(-1)).toMatchObject({ reason: "rateLimit" });
    expect(deferred!.scheduledFor.getTime()).toBeGreaterThan(Date.now());

    await settings({ perPhoneDailyCap: 20, automationDailyBudget: 2 });
    world.set("a4", { valid: true });
    await plan("a4", { serial: 4 });
    expect(await dispatchDue(NOW())).toMatchObject({ deferred: 1 });
    expect((await AutomationJobModel.findOne({ scopeId: "a4" }))!.decisions.at(-1)).toMatchObject({
      reason: "budgetExceeded",
    });
  });

  it("suppresses the identical message to the same phone within the dedupe window", async () => {
    world.set("a1", { valid: true });
    world.set("a2", { valid: true });
    await plan("a1");
    await plan("a2"); // same serial → same text
    expect(await dispatchDue(NOW())).toMatchObject({ sent: 1, skipped: 1 });
    expect((await AutomationJobModel.findOne({ status: "cancelled" }))!.decisions.at(-1)).toMatchObject({
      reason: "duplicateSuppressed",
    });
  });

  it("an opted-out patient is skipped with the reason recorded", async () => {
    world.set("a1", { valid: true });
    await PatientModel.updateOne({ _id: patient._id }, { $set: { "preferences.optOutAll": true } });
    await plan("a1");
    expect(await dispatchDue(NOW())).toMatchObject({ skipped: 1 });
    expect((await AutomationJobModel.findOne())!.decisions.at(-1)).toMatchObject({ reason: "optOut" });
    expect(sends).toHaveLength(0);
  });

  it("a failed send falls back to SMS; with no gateway the job fails with detail and can be retried", async () => {
    setWhatsAppTransport({ name: "meta", send: async () => ({ ok: false, error: "(#131026) Message undeliverable" }) });
    setSmsProvider({ name: "test-gateway", send: async () => ({ ok: true, messageId: "SMS.1" }) });
    world.set("a1", { valid: true });
    await plan("a1");
    expect(await dispatchDue(NOW())).toMatchObject({ sent: 1 });
    const rows = await OutboxMessageModel.find({ ruleKey: testRule.key }).sort({ createdAt: 1 });
    expect(rows.map((r) => [r.channel, r.status])).toEqual([
      ["whatsapp", "failed"],
      ["sms", "sent"],
    ]);

    setSmsProvider(null); // no gateway connected → the SMS attempt fails honestly too
    world.set("a2", { valid: true });
    await plan("a2", { serial: 2 });
    expect(await dispatchDue(NOW())).toMatchObject({ failed: 1 });
    const failed = await AutomationJobModel.findOne({ scopeId: "a2" });
    expect(failed).toMatchObject({ status: "failed" });
    expect(failed!.lastError).toMatch(/No SMS gateway/);
    expect(failed!.sendAttempts[0].error).toMatch(/undeliverable/);
    expect(failed!.sendAttempts.map((a) => [a.channel, a.result])).toEqual([
      ["whatsapp", "failed"],
      ["sms", "failed"],
    ]);

    setWhatsAppTransport(metaSpy);
    expect(await retryJob(failed!._id, { now: true })).toBe("sent");
    expect((await AutomationJobModel.findById(failed!._id))!.status).toBe("sent");
  });

  it("delivery webhooks update the Outbox row", async () => {
    world.set("a1", { valid: true });
    await plan("a1");
    await dispatchDue(NOW());
    const { applyDeliveryStatus } = await import("../../src/modules/automation/outbox/record");
    await applyDeliveryStatus("wamid.REAL.1", "delivered");
    await applyDeliveryStatus("wamid.REAL.1", "sent"); // late "sent" never moves it backwards
    const row = await OutboxMessageModel.findOne({ providerMessageId: "wamid.REAL.1" });
    expect(row!.status).toBe("delivered");
    expect(row!.deliveryUpdates.map((u) => u.status)).toEqual(["sent", "delivered"]);
  });
});
