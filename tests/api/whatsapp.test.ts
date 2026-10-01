import { createHmac } from "crypto";
import { setAiProvider } from "../../src/ai/ai.service";
import { drainWhatsApp } from "../../src/modules/assistant/channels/whatsapp/adapter";
import { setWhatsAppTransport } from "../../src/modules/assistant/channels/whatsapp/client";
import { renderForWhatsApp } from "../../src/modules/assistant/channels/whatsapp/render";
import { ChatMessageModel } from "../../src/modules/assistant/chatMessage.model";
import { ConversationModel } from "../../src/modules/assistant/conversation.model";
import { scriptedProvider } from "../assistant-fakes";
import { app, request, useTestDatabase } from "../helpers";

const SECRET = "test-app-secret";
const FROM = "8801711223344";

const sign = (raw: string) => `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;

const textWebhook = (id: string, body: string) => ({
  object: "whatsapp_business_account",
  entry: [
    {
      changes: [
        {
          value: {
            contacts: [{ wa_id: FROM, profile: { name: "Rahima" } }],
            messages: [{ from: FROM, id, timestamp: "1760000000", type: "text", text: { body } }],
          },
        },
      ],
    },
  ],
});

const post = async (payload: unknown, signature?: string) => {
  const raw = JSON.stringify(payload);
  const res = await request(app)
    .post("/api/v1/webhooks/whatsapp")
    .set("Content-Type", "application/json")
    .set("X-Hub-Signature-256", signature ?? sign(raw))
    .send(raw);
  await drainWhatsApp();
  return res;
};

describe("WhatsApp channel", () => {
  useTestDatabase();
  const sent: Record<string, unknown>[] = [];
  beforeEach(() => {
    sent.length = 0;
    setWhatsAppTransport({
      name: "meta",
      send: async (payload) => {
        sent.push(payload);
        return { ok: true, messageId: `wamid.OUT.${sent.length}` };
      },
    });
  });
  afterEach(() => {
    setWhatsAppTransport(null);
    setAiProvider(undefined);
  });

  it("answers Meta's webhook verification only with the right verify token", async () => {
    const good = await request(app)
      .get("/api/v1/webhooks/whatsapp")
      .query({ "hub.mode": "subscribe", "hub.verify_token": "test-verify-token", "hub.challenge": "12345" });
    expect(good.status).toBe(200);
    expect(good.text).toBe("12345");
    const bad = await request(app)
      .get("/api/v1/webhooks/whatsapp")
      .query({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "1" });
    expect(bad.status).toBe(403);
  });

  it("rejects a webhook with an invalid signature and stores nothing", async () => {
    const res = await post(textWebhook("wamid.A", "hi"), "sha256=deadbeef");
    expect(res.status).toBe(401);
    expect(await ChatMessageModel.countDocuments()).toBe(0);
  });

  it("a signed message is answered through the Cloud API; the sender's number is verified", async () => {
    setAiProvider(scriptedProvider([() => ({ text: "আসসালামু আলাইকুম!" })]).provider);
    const res = await post(textWebhook("wamid.B", "hello"));
    expect(res.status).toBe(200);
    const conv = await ConversationModel.findOne({ channel: "whatsapp" });
    expect(conv).toMatchObject({ verifiedPhone: "+8801711223344", profileName: "Rahima" });
    expect(sent[0]).toMatchObject({ messaging_product: "whatsapp", to: FROM, type: "text" });
    const reply = await ChatMessageModel.findOne({ sender: "bot" });
    expect(reply).toMatchObject({ deliveryStatus: "sent", externalMessageId: "wamid.OUT.1" });
  });

  it("a retried webhook (same message id) is processed once — no double reply", async () => {
    const fake = scriptedProvider([() => ({ text: "ok" })]);
    setAiProvider(fake.provider);
    await post(textWebhook("wamid.C", "hello"));
    const firstSends = sent.length;
    await post(textWebhook("wamid.C", "hello"));
    expect(fake.calls).toHaveLength(1);
    expect(sent.length).toBe(firstSends);
    expect(await ChatMessageModel.countDocuments({ direction: "inbound" })).toBe(1);
  });

  it("button replies map back to the engine's reply ids; delivery statuses are recorded", async () => {
    setAiProvider(scriptedProvider([() => ({ text: "A staff member will help." })]).provider);
    await post({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: FROM,
                    id: "wamid.D",
                    type: "interactive",
                    interactive: {
                      type: "button_reply",
                      button_reply: { id: "menu|human", title: "Talk to a person" },
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect((await ConversationModel.findOne())?.status).toBe("needs_human");

    await post({ entry: [{ changes: [{ value: { statuses: [{ id: "wamid.OUT.1", status: "delivered" }] } }] }] });
    expect((await ChatMessageModel.findOne({ externalMessageId: "wamid.OUT.1" }))?.deliveryStatus).toBe("delivered");
  });

  it("images get a polite 'text only' answer", async () => {
    await post({
      entry: [
        { changes: [{ value: { messages: [{ from: FROM, id: "wamid.E", type: "image", image: { id: "m1" } }] } }] },
      ],
    });
    expect(JSON.stringify(sent[0])).toContain("only read text");
  });

  it("no reply is sent outside the 24-hour customer service window", async () => {
    setAiProvider(scriptedProvider([() => ({ text: "ok" })]).provider);
    await post(textWebhook("wamid.F", "hi"));
    const conv = (await ConversationModel.findOne())!;
    conv.lastInboundAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await conv.save();
    const { whatsappAdapter } = await import("../../src/modules/assistant/channels/whatsapp/adapter");
    const doc = await ChatMessageModel.create({
      conversation: conv._id,
      channel: "whatsapp",
      direction: "outbound",
      sender: "staff",
      text: "late",
    });
    const before = sent.length;
    await whatsappAdapter.deliver(conv, [{ doc, message: { type: "text", text: "late" } }]);
    expect(sent.length).toBe(before);
    expect((await ChatMessageModel.findById(doc._id))?.deliveryError).toContain("24-hour");
  });
});

describe("WhatsApp rendering limits", () => {
  const opt = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `o|${i}`, label: `Option ${i + 1}` }));

  it("≤3 quick replies → reply buttons; more → a list; over 10 → numbered text", () => {
    expect(renderForWhatsApp({ type: "quick_replies", text: "Pick", options: opt(3) }).bodies[0]).toMatchObject({
      interactive: { type: "button" },
    });
    expect(renderForWhatsApp({ type: "quick_replies", text: "Pick", options: opt(6) }).bodies[0]).toMatchObject({
      interactive: { type: "list" },
    });
    const big = renderForWhatsApp({ type: "list", kind: "options", text: "Pick", button: "Choose", items: opt(12) });
    expect(big.bodies[0]).toMatchObject({ type: "text" });
    expect(big.numberedOptions).toHaveLength(12);
  });

  it("long bilingual button titles use the half that fits (20 characters)", () => {
    const r = renderForWhatsApp({
      type: "quick_replies",
      text: "?",
      options: [{ id: "menu|human", label: "মানুষের সাথে কথা বলুন · Talk to a person" }],
    });
    const title = (r.bodies[0] as { interactive: { action: { buttons: { reply: { title: string } }[] } } }).interactive
      .action.buttons[0].reply.title;
    expect(title.length).toBeLessThanOrEqual(20);
  });
});
