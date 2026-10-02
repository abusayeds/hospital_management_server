import { Types } from "mongoose";
import { env } from "../../config/env";
import { logger } from "../../utils/logger";
import { PatientModel } from "../patients/patient.model";
import type { ConversationDocument } from "./conversation.model";

/**
 * ONE-TIME CODE DELIVERY (patient portal sign-in). The web chat books without a code; WhatsApp
 * chats are tied to the sender's own number.
 *  - delivery through OtpSender implementations: WhatsApp when configured and the number is on
 *    WhatsApp, otherwise the log (development). An SMS sender plugs in here later.
 */

export type OtpSender = { name: "whatsapp" | "log"; send: (phone: string, code: string) => Promise<boolean> };

const logSender: OtpSender = {
  name: "log",
  send: async (phone, code) => {
    if (env.NODE_ENV === "production") {
      logger.warn({ phoneEnd: phone.slice(-3) }, "OTP requested but no SMS/WhatsApp sender is configured");
      return false;
    }
    logger.info({ phoneEnd: phone.slice(-3), code }, "DEV OTP (visible only outside production)");
    return true;
  },
};

const senders: OtpSender[] = [];
/** WhatsApp (Step F) registers itself here; tried before the log sender */
export const registerOtpSender = (sender: OtpSender) => senders.unshift(sender);

/** Send a code through the first sender that succeeds (WhatsApp when configured, else the dev log) */
export const deliverCode = async (phone: string, code: string): Promise<"log" | "whatsapp" | null> => {
  for (const sender of [...senders, logSender])
    if (await sender.send(phone, code).catch(() => false)) return sender.name;
  return null;
};

export const maskPhone = (e164: string) => `${e164.slice(0, 7)}•••${e164.slice(-3)}`.replace("+88", "");

/** Patients registered with the verified phone (families share phones) */
export const linkPatients = async (conv: ConversationDocument) => {
  const patients = await PatientModel.find({ phone: conv.verifiedPhone })
    .select("_id")
    .lean<{ _id: Types.ObjectId }[]>();
  conv.linkedPatientIds = patients.map((p) => p._id);
  return conv.linkedPatientIds;
};
