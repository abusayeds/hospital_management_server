import { logger } from "../../../utils/logger";

/**
 * SMS FALLBACK HOOK. Used when WhatsApp cannot deliver (number not on WhatsApp, no approved
 * template, Meta error). No Bangladeshi SMS gateway is connected yet, so the default provider honestly
 * reports "not sent" (the Outbox shows a failed SMS row with the reason). A real gateway (e.g. SSL
 * Wireless, BulkSMSBD) implements SmsProvider and is passed to setSmsProvider() at startup — nothing
 * else changes.
 */
export type SmsResult = { ok: true; messageId: string } | { ok: false; error: string };

export interface SmsProvider {
  name: string;
  send(to: string, text: string): Promise<SmsResult>;
}

export const noSmsGateway: SmsProvider = {
  name: "none",
  async send(to) {
    logger.info({ to: `${to.slice(0, 6)}•••${to.slice(-2)}` }, "SMS not sent: no SMS gateway connected");
    return { ok: false, error: "No SMS gateway connected yet" };
  },
};

let provider: SmsProvider = noSmsGateway;
/** Connect a real SMS gateway (startup), or a fake one in automated tests */
export const setSmsProvider = (p: SmsProvider | null) => {
  provider = p ?? noSmsGateway;
};
export const smsProvider = () => provider;
export const smsInfo = () => ({ provider: provider.name, connected: provider !== noSmsGateway });
