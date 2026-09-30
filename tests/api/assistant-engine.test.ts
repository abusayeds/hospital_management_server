import { setAiProvider } from "../../src/ai/ai.service";
import { ChatMessageModel } from "../../src/modules/assistant/chatMessage.model";
import { ConversationModel } from "../../src/modules/assistant/conversation.model";
import { handleInbound } from "../../src/modules/assistant/engine";
import { scriptedProvider } from "../assistant-fakes";
import { useTestDatabase } from "../helpers";

describe("Assistant engine", () => {
  useTestDatabase();
  afterEach(() => setAiProvider(undefined));

  it("runs the tool loop: the model calls a tool, gets the result, then answers", async () => {
    const fake = scriptedProvider([
      () => ({ toolCalls: [{ id: "1", name: "get_hospital_info", args: {} }] }),
      (req) => {
        const toolTurn = req.turns.at(-1);
        expect(toolTurn?.role).toBe("tool");
        return { text: "আমাদের হাসপাতাল কেরানীগঞ্জে।" };
      },
    ]);
    setAiProvider(fake.provider);

    const res = await handleInbound({ channel: "web", channelUserId: "a".repeat(32), text: "hospital kothay?" });
    expect(res.messages[0]).toEqual({ type: "text", text: "আমাদের হাসপাতাল কেরানীগঞ্জে।" });
    const reply = await ChatMessageModel.findOne({ sender: "bot" });
    expect(reply?.toolCalls[0]).toMatchObject({ name: "get_hospital_info", success: true });
    expect(res.conversation.language).toBe("mixed");
  });

  it("never goes silent: an AI failure gives a bilingual fallback with a 'talk to a person' option", async () => {
    setAiProvider({
      name: "broken",
      generate: async () => ({ text: "", model: "x" }),
      chat: async () => {
        throw new Error("boom");
      },
    });
    const res = await handleInbound({ channel: "web", channelUserId: "b".repeat(32), text: "hello" });
    expect(res.messages[0]).toMatchObject({ type: "quick_replies", options: [{ id: "menu|human" }] });
    expect((res.messages[0] as { text: string }).text).toContain("Sorry");
  });

  it("a provider message id is processed once (webhook retries)", async () => {
    const fake = scriptedProvider([() => ({ text: "ok" })]);
    setAiProvider(fake.provider);
    const msg = {
      channel: "whatsapp" as const,
      channelUserId: "8801711223344",
      text: "hi",
      externalMessageId: "wamid.1",
    };
    await handleInbound(msg);
    const again = await handleInbound(msg);
    expect(again.duplicate).toBe(true);
    expect(fake.calls).toHaveLength(1);
    // WhatsApp's own number counts as verified for that number
    const conv = await ConversationModel.findOne({ channel: "whatsapp" });
    expect(conv?.verifiedPhone).toBe("+8801711223344");
  });

  it("stays silent while a staff member has taken over", async () => {
    const fake = scriptedProvider([() => ({ text: "bot reply" })]);
    setAiProvider(fake.provider);
    await ConversationModel.create({ channel: "web", channelUserId: "c".repeat(32), status: "human_active" });
    const res = await handleInbound({ channel: "web", channelUserId: "c".repeat(32), text: "are you there?" });
    expect(res.messages).toEqual([]);
    expect(fake.calls).toHaveLength(0);
    expect(await ChatMessageModel.countDocuments({ sender: "patient" })).toBe(1);
  });
});
