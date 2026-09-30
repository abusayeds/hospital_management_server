/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from "zod";
import AppError from "../../../errors/AppError";
import { ageOn } from "../../../utils/date";
import { createPatient } from "../../patients/patient.service";
import { PatientModel } from "../../patients/patient.model";
import type { OutboundMessage } from "../assistant.types";
import type { ConversationDocument } from "../conversation.model";
import { registerInteraction } from "../interactions";
import {
  hasPendingVerification,
  linkPatients,
  OTP_RESEND_SECONDS,
  startVerification,
  verifyCode,
} from "../otp.service";
import { refFor } from "../refs";
import { maskCode, patientForModel, sourceOf } from "./shared";
import { defineTool } from "./types";

/** The family list shown after verification: each patient on the phone + "someone else" */
export const patientsMessage = async (conv: ConversationDocument): Promise<OutboundMessage> => {
  const patients = await PatientModel.find({ phone: conv.verifiedPhone }).sort({ createdAt: 1 }).limit(9).lean<any[]>();
  return {
    type: "list",
    kind: "patients",
    text: patients.length
      ? "কার জন্য সিরিয়াল নিতে চান? · Who is the appointment for?"
      : "এই নম্বরে কোনো রোগী নিবন্ধিত নেই। রোগীর নাম, বয়স ও লিঙ্গ লিখুন। · No patient on this number yet — tell me the name, age and gender.",
    button: "রোগী বাছুন",
    items: [
      ...patients.map((p) => ({
        id: `patient|${refFor(conv, "P", String(p._id))}`,
        label: p.name,
        description: `${maskCode(p.patientCode)} · ${ageOn(p.dateOfBirth)} y`,
      })),
      { id: "patient|new", label: "অন্য কেউ (নতুন রোগী) · Someone else" },
    ],
  };
};

export const startVerificationTool = defineTool({
  name: "start_verification",
  description:
    "Send a 6-digit code to the patient's Bangladeshi mobile number to verify it (needed before any personal action).",
  parameters: {
    type: "object",
    properties: { phone: { type: "string", description: "Mobile number as the patient typed it, e.g. 01711223344" } },
    required: ["phone"],
  },
  schema: z.object({ phone: z.string().trim().min(8).max(20) }),
  run: async ({ phone }, ctx) => {
    if (ctx.conversation.verifiedPhone) return { summary: "already verified", data: { status: "already_verified" } };
    const r = await startVerification(ctx.conversation, phone);
    return {
      summary: "code sent",
      data: { status: "code_sent", note: "Ask the patient to type the 6-digit code they received." },
      ui: [
        {
          type: "otp_request",
          text: `${r.phoneMasked} নম্বরে ৬ সংখ্যার কোড পাঠানো হয়েছে। কোডটি লিখুন। · Enter the 6-digit code sent to ${r.phoneMasked}.`,
          phoneMasked: r.phoneMasked,
          resendAfterSeconds: OTP_RESEND_SECONDS,
        },
      ],
    };
  },
});

export const verifyCodeTool = defineTool({
  name: "verify_code",
  description: "Check the 6-digit verification code the patient typed.",
  parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
  schema: z.object({
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/, "must be 6 digits"),
  }),
  run: async ({ code }, ctx) => {
    await verifyCode(ctx.conversation, code);
    const patients = await PatientModel.find({ phone: ctx.conversation.verifiedPhone }).lean<any[]>();
    return {
      summary: "verified",
      data: { verified: true, patients: patients.map((p) => patientForModel(ctx.conversation, p)) },
      ui: [await patientsMessage(ctx.conversation)],
    };
  },
});

export const listMyPatients = defineTool({
  name: "list_my_patients",
  description: "Patients registered with the verified phone number (families share one phone).",
  parameters: { type: "object", properties: {} },
  schema: z.object({}).passthrough(),
  needsVerification: true,
  run: async (_args, ctx) => {
    await linkPatients(ctx.conversation);
    const patients = await PatientModel.find({ phone: ctx.conversation.verifiedPhone })
      .sort({ createdAt: 1 })
      .lean<any[]>();
    return {
      summary: `${patients.length} patients`,
      data: patients.map((p) => patientForModel(ctx.conversation, p)),
      ui: [await patientsMessage(ctx.conversation)],
    };
  },
});

export const registerPatientTool = defineTool({
  name: "register_patient",
  description:
    "Register a NEW patient on the verified phone (e.g. a family member). Only after the patient gave name, gender and age.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Full name" },
      gender: { type: "string", enum: ["male", "female", "other"] },
      age: { type: "number", description: "Age in years" },
    },
    required: ["name", "gender", "age"],
  },
  schema: z.object({
    name: z.string().trim().min(2).max(100),
    gender: z.enum(["male", "female", "other"]),
    age: z.coerce.number().int().min(0).max(120),
  }),
  needsVerification: true,
  run: async ({ name, gender, age }, ctx) => {
    const conv = ctx.conversation;
    try {
      const p = await createPatient(
        { name, gender, ageYears: age, phone: conv.verifiedPhone!, registrationSource: sourceOf(conv) },
        {},
      );
      await linkPatients(conv);
      return { summary: "patient registered", data: { registered: true, patient: patientForModel(conv, p) } };
    } catch (err) {
      // Same phone + similar name already exists → use that record instead of creating a duplicate
      if (err instanceof AppError && err.code === "DUPLICATE_KEY") {
        const existing = (err.details as { possibleDuplicates: { id: string }[] }).possibleDuplicates[0];
        const p = await PatientModel.findById(existing.id).lean<any>();
        return {
          summary: "already registered",
          data: { registered: false, alreadyExists: true, patient: patientForModel(conv, p) },
        };
      }
      throw err;
    }
  },
});

/** A 6-digit message (or the OTP box) while a code is pending is checked in code, not by the model */
registerInteraction(async (conv, replyId, text) => {
  const typed = /^\s*\d{6}\s*$/.test(text ?? "") ? text!.trim() : null;
  const code = replyId.startsWith("otp|") ? replyId.slice(4) : typed;
  if (!code || conv.verifiedPhone || !(await hasPendingVerification(conv))) return null;
  try {
    await verifyCode(conv, code);
    return {
      messages: [
        { type: "text", text: "✅ আপনার নম্বর যাচাই হয়েছে। · Your number is verified." },
        await patientsMessage(conv),
      ],
    };
  } catch (err) {
    return { messages: [{ type: "text", text: err instanceof AppError ? err.message : "Could not verify the code." }] };
  }
});
