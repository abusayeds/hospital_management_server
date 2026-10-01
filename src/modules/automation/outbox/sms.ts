import { randomBytes } from "crypto";
import { logger } from "../../../utils/logger";

/**
 * SMS FALLBACK HOOK. Used when WhatsApp cannot deliver (number not on WhatsApp, no approved
 * template, Meta error). No Bangladeshi SMS gateway is wired yet: the stub provider only logs the
 * masked number. A real gateway (e.g. SSL Wireless, BulkSMSBD) implements SmsProvider and is passed to
 * setSmsProvider() at startup — nothing else changes.
 */
export type SmsResult = { ok: true; messageId: string } | { ok: false; error: string };

export interface SmsProvider {
  name: string;
  real: boolean; // false = nothing actually leaves the server
  send(to: string, text: string): Promise<SmsResult>;
}

export const stubSmsProvider: SmsProvider = {
  name: "stub",
  real: false,
  async send(to, text) {
    logger.info({ to: `${to.slice(0, 6)}•••${to.slice(-2)}`, length: text.length }, "SMS stub: message logged");
    return { ok: true, messageId: `SMS.STUB.${randomBytes(6).toString("hex")}` };
  },
};

/** Simulation (dry-run) adapter: same as the stub, labelled for the simulator view */
export const simulatedSmsProvider: SmsProvider = {
  name: "simulator",
  real: false,
  async send() {
    return { ok: true, messageId: `SMS.SIM.${randomBytes(6).toString("hex")}` };
  },
};

let provider: SmsProvider = stubSmsProvider;
export const setSmsProvider = (p: SmsProvider) => {
  provider = p;
};
export const smsProviderFor = (simulated: boolean) => (simulated ? simulatedSmsProvider : provider);
export const smsInfo = () => ({ provider: provider.name, real: provider.real });
