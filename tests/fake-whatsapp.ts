import { setWhatsAppTransport, Transport } from "../src/modules/assistant/channels/whatsapp/client";

/**
 * Automated tests must never reach Meta (or anybody's phone): this replaces the WhatsApp transport with
 * one that only records what would have been sent.
 */
export const useFakeWhatsApp = () => {
  const sent: Record<string, unknown>[] = [];
  let n = 0;
  const transport: Transport = {
    name: "test",
    send: async (payload) => {
      sent.push(payload);
      n += 1;
      return { ok: true, messageId: `wamid.TEST.${n}` };
    },
  };
  beforeEach(() => {
    sent.length = 0;
    setWhatsAppTransport(transport);
  });
  afterEach(() => setWhatsAppTransport(null));
  return { sent };
};
