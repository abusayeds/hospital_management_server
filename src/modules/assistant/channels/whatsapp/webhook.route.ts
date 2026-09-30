import { createHmac, timingSafeEqual } from "crypto";
import express, { Request, Response } from "express";
import { env } from "../../../../config/env";
import { logger } from "../../../../utils/logger";
import { processInBackground } from "./adapter";
import { isWhatsAppConfigured } from "./client";

/**
 * META WEBHOOK (public, no login).
 *  GET  — Meta's one-time verification: echo hub.challenge when hub.verify_token matches.
 *  POST — events. The X-Hub-Signature-256 header must be an HMAC-SHA256 of the RAW body with the
 *         app secret; anything else is rejected (401). We answer 200 at once and process in the
 *         background, so Meta does not time out and retry.
 */

export const signatureValid = (raw: Buffer, header: string | undefined) => {
  if (!env.WHATSAPP_APP_SECRET || !header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", env.WHATSAPP_APP_SECRET).update(raw).digest("hex")}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
};

const router = express.Router();

router.get("/", (req: Request, res: Response) => {
  // Read from the raw URL: the NoSQL sanitizer removes query keys with dots ("hub.mode")
  const q = new URL(req.originalUrl, "http://localhost").searchParams;
  const ok =
    isWhatsAppConfigured() &&
    q.get("hub.mode") === "subscribe" &&
    q.get("hub.verify_token") === env.WHATSAPP_VERIFY_TOKEN;
  if (!ok) return void res.sendStatus(403);
  res
    .status(200)
    .type("text/plain")
    .send(q.get("hub.challenge") ?? "");
});

router.post("/", (req: Request, res: Response) => {
  if (!isWhatsAppConfigured()) return void res.sendStatus(404);
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  if (!signatureValid(raw, req.get("x-hub-signature-256"))) {
    logger.warn({ ip: req.ip }, "WhatsApp webhook with an invalid signature rejected");
    return void res.sendStatus(401);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return void res.sendStatus(400);
  }
  res.sendStatus(200);
  processInBackground(payload as Parameters<typeof processInBackground>[0]);
});

export const WhatsAppWebhookRoutes = router;
