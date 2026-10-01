import { setAiProvider } from "../../src/ai/ai.service";
import { AuditLogModel } from "../../src/modules/audit/auditLog.model";
import { setWhatsAppTransport } from "../../src/modules/assistant/channels/whatsapp/client";
import { ChatMessageModel } from "../../src/modules/assistant/chatMessage.model";
import { ConversationModel } from "../../src/modules/assistant/conversation.model";
import { handleInbound } from "../../src/modules/assistant/engine";
import { dispatchDue } from "../../src/modules/automation/dispatcher";
import { runPlanner } from "../../src/modules/automation/engine";
import { OutboxMessageModel } from "../../src/modules/automation/models/outbox.model";
import { getRule } from "../../src/modules/automation/rules/registry";
import { ensureDefaultTemplates } from "../../src/modules/automation/templates/template.service";
import { clearSettingsCache } from "../../src/modules/hospital/settings/settings.service";
import { scriptedProvider } from "../assistant-fakes";
import { createUser, signIn, useTestDatabase } from "../helpers";

const WEB = "a1".repeat(16);

describe("Staff inbox", () => {
  useTestDatabase();
  beforeEach(() => clearSettingsCache());
  afterEach(() => {
    setAiProvider(undefined);
    setWhatsAppTransport(null);
  });

  const reception = async () => {
    await createUser({ role: "reception", email: "rec@test.local" });
    return signIn("rec@test.local");
  };

  it("emergencies are listed first and counted in the summary", async () => {
    setAiProvider(scriptedProvider([() => ({ text: "ok" })]).provider);
    await handleInbound({ channel: "web", channelUserId: WEB, text: "hello" });
    await handleInbound({ channel: "web", channelUserId: "b2".repeat(16), text: "বুকে প্রচুর ব্যথা" });
    const rec = await reception();

    const list = await rec.get("/api/v1/assistant/inbox/conversations?filter=all");
    expect(list.body.data[0]).toMatchObject({ emergency: true, status: "needs_human", tags: ["EMERGENCY"] });
    const summary = await rec.get("/api/v1/assistant/inbox/summary");
    expect(summary.body.data).toMatchObject({ needsHuman: 1, emergency: 1 });
  });

  it("take over silences the assistant, staff replies go to the patient, hand back resumes the bot (all audited)", async () => {
    const fake = scriptedProvider([() => ({ text: "bot answer" })]);
    setAiProvider(fake.provider);
    const first = await handleInbound({ channel: "web", channelUserId: WEB, text: "I need help" });
    const id = String(first.conversation._id);
    const rec = await reception();

    const taken = await rec.post(`/api/v1/assistant/inbox/conversations/${id}/takeover`);
    expect(taken.body.data.conversation).toMatchObject({
      status: "human_active",
      assignedTo: { name: expect.any(String) },
    });

    const callsBefore = fake.calls.length;
    const silent = await handleInbound({ channel: "web", channelUserId: WEB, text: "hello?" });
    expect(silent.messages).toEqual([]);
    expect(fake.calls.length).toBe(callsBefore);

    const reply = await rec.post(`/api/v1/assistant/inbox/conversations/${id}/reply`).send({ text: "আমি দেখছি।" });
    expect(reply.body.data).toMatchObject({ sender: "staff", text: "আমি দেখছি।", staffName: expect.any(String) });

    await rec.post(`/api/v1/assistant/inbox/conversations/${id}/handback`);
    const back = await handleInbound({ channel: "web", channelUserId: WEB, text: "thanks" });
    expect(back.messages[0]).toMatchObject({ text: "bot answer" });

    const events = (await AuditLogModel.find({ entityType: "Conversation", action: "UPDATE" }).lean()).map(
      (a) => (a.meta as { event: string }).event,
    );
    expect(events).toEqual(expect.arrayContaining(["takeover", "staff_reply", "hand_back"]));
  });

  it("opening a conversation shows the transcript with tool-call chips and marks it read", async () => {
    setAiProvider(
      scriptedProvider([
        () => ({ toolCalls: [{ name: "list_departments", args: {} }] }),
        () => ({ text: "Here are our departments." }),
      ]).provider,
    );
    const r = await handleInbound({ channel: "web", channelUserId: WEB, text: "departments?" });
    const rec = await reception();
    const res = await rec.get(`/api/v1/assistant/inbox/conversations/${r.conversation._id}`);
    const bot = res.body.data.messages.find((m: { sender: string }) => m.sender === "bot");
    expect(bot.toolCalls[0]).toMatchObject({ name: "list_departments", success: true });
    expect((await ConversationModel.findById(r.conversation._id))?.unreadCount).toBe(0);
  });

  it("a WhatsApp reply outside the 24-hour window is refused with a clear message", async () => {
    setAiProvider(scriptedProvider([() => ({ text: "ok" })]).provider);
    setWhatsAppTransport({ name: "meta", send: async () => ({ ok: true, messageId: "wamid.X" }) });
    const r = await handleInbound({
      channel: "whatsapp",
      channelUserId: "8801711000009",
      text: "hi",
      externalMessageId: "w1",
    });
    await ConversationModel.updateOne(
      { _id: r.conversation._id },
      { $set: { lastInboundAt: new Date(Date.now() - 26 * 3600e3) } },
    );
    const rec = await reception();
    const res = await rec
      .post(`/api/v1/assistant/inbox/conversations/${r.conversation._id}/reply`)
      .send({ text: "hello" });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain("24 hours");
  });

  it("reminds staff once when a patient waits in a taken-over chat (automation rule 8)", async () => {
    await ensureDefaultTemplates();
    const conv = await ConversationModel.create({
      channel: "web",
      channelUserId: WEB,
      status: "human_active",
      takenOverAt: new Date(Date.now() - 20 * 60_000),
      lastInboundAt: new Date(Date.now() - 10 * 60_000),
    });
    const rule = getRule("chat_no_reply")!;
    expect((await runPlanner(rule)).created).toBe(1);
    expect((await runPlanner(rule)).created).toBe(0); // once per waiting message
    expect(await dispatchDue()).toMatchObject({ sent: 1 });
    const alert = await OutboxMessageModel.findOne({ ruleKey: "chat_no_reply" });
    expect(alert).toMatchObject({ channel: "inapp", toRef: "perm:inbox:manage" });
    expect((await ConversationModel.findById(conv._id))!.remindedAt).toBeTruthy();
    await ChatMessageModel.deleteMany({ conversation: conv._id });
  });

  it("roles without inbox:manage cannot open the inbox", async () => {
    await createUser({ role: "pharmacist", email: "ph@test.local" });
    const ph = await signIn("ph@test.local");
    expect((await ph.get("/api/v1/assistant/inbox/conversations")).status).toBe(403);
  });

  it("counts unread patient messages, lists them under Unread, clears them on open, and can mark a chat unread again", async () => {
    setAiProvider(scriptedProvider([() => ({ text: "ok" })]).provider);
    await handleInbound({ channel: "web", channelUserId: "c3".repeat(16), text: "বুকে প্রচুর ব্যথা" });
    await handleInbound({ channel: "web", channelUserId: "c3".repeat(16), text: "এখনই কাউকে দরকার" });
    const rec = await reception();

    const before = (await rec.get("/api/v1/assistant/inbox/summary")).body.data;
    expect(before).toMatchObject({ unreadChats: 1, unreadMessages: 2, waitingChats: 1 });
    const unread = await rec.get("/api/v1/assistant/inbox/conversations?filter=unread");
    expect(unread.body.data).toHaveLength(1);
    const id = unread.body.data[0].id as string;

    await rec.get(`/api/v1/assistant/inbox/conversations/${id}`); // opening = read
    expect((await rec.get("/api/v1/assistant/inbox/summary")).body.data).toMatchObject({ unreadChats: 0, unreadMessages: 0 });
    expect((await rec.get("/api/v1/assistant/inbox/conversations?filter=unread")).body.data).toHaveLength(0);

    const marked = await rec.post(`/api/v1/assistant/inbox/conversations/${id}/unread`);
    expect(marked.body.data).toMatchObject({ unreadCount: 1 });
    expect((await rec.get("/api/v1/assistant/inbox/summary")).body.data.unreadChats).toBe(1);
    expect(await AuditLogModel.exists({ entityType: "Conversation", "meta.event": "mark_unread" })).toBeTruthy();
  });
});
