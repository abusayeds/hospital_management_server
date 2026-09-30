import { createHmac, randomInt, timingSafeEqual } from "crypto";
import { Types } from "mongoose";
import { env } from "../../config/env";
import AppError from "../../errors/AppError";
import { logger } from "../../utils/logger";
import { toE164Bd } from "../../utils/phone";
import { PatientModel } from "../patients/patient.model";
import type { ConversationDocument } from "./conversation.model";
import { VerificationModel } from "./verification.model";

/**
 * PHONE VERIFICATION (web chat). WhatsApp does not need it: the sender's number is verified by
 * WhatsApp itself.
 *  - 6-digit code from crypto.randomInt, only an HMAC of it is stored, valid 5 minutes (TTL index)
 *  - max 5 wrong attempts per code; max 3 codes per phone per hour; 60 s between resends
 *  - delivery through OtpSender implementations: WhatsApp when configured and the number is on
 *    WhatsApp, otherwise the log (development). An SMS sender plugs in here later.
 */

export const OTP_TTL_MS = 5 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_MAX_PER_HOUR = 3;
export const OTP_RESEND_SECONDS = 60;

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

const hashCode = (conversationId: string, code: string) =>
  createHmac("sha256", env.JWT_SECRET_KEY).update(`otp:${conversationId}:${code}`).digest("hex");

export const maskPhone = (e164: string) => `${e164.slice(0, 7)}•••${e164.slice(-3)}`.replace("+88", "");

export const startVerification = async (conv: ConversationDocument, phoneInput: string) => {
  const phone = toE164Bd(phoneInput);
  if (!phone)
    throw new AppError(400, "That is not a valid Bangladeshi mobile number (01XXXXXXXXX).", "VALIDATION_ERROR");

  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recent = await VerificationModel.find({ phone, createdAt: { $gte: hourAgo } })
    .sort({ createdAt: -1 })
    .lean<{ createdAt: Date }[]>();
  if (recent.length >= OTP_MAX_PER_HOUR)
    throw new AppError(429, "Too many codes for this number. Please try again in an hour.", "RATE_LIMITED");
  const last = recent[0];
  if (last && Date.now() - new Date(last.createdAt).getTime() < OTP_RESEND_SECONDS * 1000)
    throw new AppError(429, "A code was just sent. Please wait a minute before asking again.", "RATE_LIMITED");

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  let deliveredVia: "log" | "whatsapp" = "log";
  for (const sender of [...senders, logSender]) {
    if (await sender.send(phone, code).catch(() => false)) {
      deliveredVia = sender.name;
      break;
    }
  }
  await VerificationModel.create({
    conversation: conv._id,
    phone,
    codeHash: hashCode(String(conv._id), code),
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
    deliveredVia,
    devCode: env.NODE_ENV === "production" ? null : code,
  });
  return { phone, phoneMasked: maskPhone(phone), deliveredVia };
};

/** Check a code; on success the conversation is verified for that phone and its patients are linked */
export const verifyCode = async (conv: ConversationDocument, code: string) => {
  const v = await VerificationModel.findOne({
    conversation: conv._id,
    usedAt: null,
    expiresAt: { $gt: new Date() },
  }).sort({ createdAt: -1 });
  if (!v) throw new AppError(400, "No active code. Please ask for a new code.", "VALIDATION_ERROR");
  if (v.attempts >= OTP_MAX_ATTEMPTS)
    throw new AppError(429, "Too many wrong attempts. Please ask for a new code.", "RATE_LIMITED");

  v.attempts += 1;
  const given = Buffer.from(hashCode(String(conv._id), code.trim()));
  const ok = given.length === v.codeHash.length && timingSafeEqual(given, Buffer.from(v.codeHash));
  if (!ok) {
    await v.save();
    const left = OTP_MAX_ATTEMPTS - v.attempts;
    throw new AppError(400, `The code is not correct. ${left} attempt(s) left.`, "VALIDATION_ERROR");
  }
  v.usedAt = new Date();
  await v.save();

  conv.phone = v.phone;
  conv.verifiedPhone = v.phone;
  conv.verifiedAt = new Date();
  await linkPatients(conv);
  await conv.save();
  return { phone: v.phone };
};

/** Patients registered with the verified phone (families share phones) */
export const linkPatients = async (conv: ConversationDocument) => {
  const patients = await PatientModel.find({ phone: conv.verifiedPhone })
    .select("_id")
    .lean<{ _id: Types.ObjectId }[]>();
  conv.linkedPatientIds = patients.map((p) => p._id);
  return conv.linkedPatientIds;
};

export const hasPendingVerification = (conv: ConversationDocument) =>
  VerificationModel.exists({ conversation: conv._id, usedAt: null, expiresAt: { $gt: new Date() } });
