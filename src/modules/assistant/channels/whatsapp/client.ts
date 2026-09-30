import { randomBytes } from "crypto";
import { env } from "../../../../config/env";
import { logger } from "../../../../utils/logger";
import type { WaBody } from "./render";

/**
 * WHATSAPP CLOUD API CLIENT.
 *  - disabled cleanly when the env variables are missing (isWhatsAppConfigured() === false)
 *  - retries transient failures (network, 429, 5xx) with exponential backoff; 4xx are final
 *  - the SIMULATOR transport captures payloads instead of calling Meta (same code path otherwise)
 */

export const isWhatsAppConfigured = () =>
  Boolean(
    env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_APP_SECRET && env.WHATSAPP_VERIFY_TOKEN,
  );

const graphUrl = () =>
  `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

export type SendResult = { ok: true; messageId: string } | { ok: false; error: string };

export type Transport = { name: "meta" | "simulator"; send: (payload: Record<string, unknown>) => Promise<SendResult> };

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const retrySettings = { attempts: 3, baseDelayMs: 500 };

const metaTransport: Transport = {
  name: "meta",
  async send(payload) {
    let lastError = "not sent";
    for (let attempt = 1; attempt <= retrySettings.attempts; attempt++) {
      try {
        const res = await fetch(graphUrl(), {
          method: "POST",
          headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10_000),
        });
        const json = (await res.json().catch(() => ({}))) as {
          messages?: { id: string }[];
          error?: { message?: string };
        };
        if (res.ok && json.messages?.[0]?.id) return { ok: true, messageId: json.messages[0].id };
        lastError = json.error?.message ?? `HTTP ${res.status}`;
        if (res.status < 500 && res.status !== 429) break; // bad request, expired token, outside 24 h window …
      } catch (err) {
        lastError = (err as Error).message; // network / timeout → retry
      }
      if (attempt < retrySettings.attempts) await wait(retrySettings.baseDelayMs * 2 ** (attempt - 1));
    }
    logger.error({ error: lastError }, "WhatsApp send failed");
    return { ok: false, error: lastError.slice(0, 300) };
  },
};

/** Simulator: nothing leaves the server; the payload is stored on the message and shown in the admin phone UI */
export const simulatorTransport: Transport = {
  name: "simulator",
  async send() {
    return { ok: true, messageId: `wamid.SIM.${randomBytes(8).toString("hex")}` };
  },
};

let metaOverride: Transport | null = null;
/** Tests replace the Meta transport so nothing is sent over the internet */
export const setWhatsAppTransport = (t: Transport | null) => {
  metaOverride = t;
};

export const transportFor = (simulated: boolean): Transport =>
  simulated ? simulatorTransport : (metaOverride ?? metaTransport);

/** Full request body for one message to one number */
export const toPayload = (to: string, body: WaBody) => ({
  messaging_product: "whatsapp",
  recipient_type: "individual",
  to,
  ...body,
});

/** Blue ticks: tell WhatsApp we read the patient's message (best effort) */
export const markAsRead = async (messageId: string) => {
  if (!isWhatsAppConfigured() || messageId.startsWith("wamid.SIM.")) return;
  await fetch(graphUrl(), {
    method: "POST",
    headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: messageId }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => undefined);
};
