/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from "zod";
import AppError from "../../../errors/AppError";
import { ageOn } from "../../../utils/date";
import { toE164Bd } from "../../../utils/phone";
import { createPatient } from "../../patients/patient.service";
import { PatientModel } from "../../patients/patient.model";
import type { OutboundMessage } from "../assistant.types";
import type { ConversationDocument } from "../conversation.model";
import { linkPatients } from "../otp.service";
import { refFor } from "../refs";
import { contactPhone, maskCode, myPatientsFilter, patientForModel, sourceOf } from "./shared";
import { defineTool } from "./types";

/** "Who is it for?": the patients this chat may book for + "someone else" */
export const patientsMessage = async (conv: ConversationDocument): Promise<OutboundMessage> => {
  const patients = await PatientModel.find(myPatientsFilter(conv)).sort({ createdAt: 1 }).limit(9).lean<any[]>();
  return {
    type: "list",
    kind: "patients",
    text: patients.length
      ? "কার জন্য সিরিয়াল নিতে চান? · Who is the appointment for?"
      : "রোগীর নাম, বয়স ও লিঙ্গ লিখুন। · Tell me the patient's name, age and gender.",
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

export const setPhoneTool = defineTool({
  name: "set_phone",
  description:
    "Save the patient's Bangladeshi mobile number for booking (no code is sent). Call it as soon as the patient gives the number.",
  parameters: {
    type: "object",
    properties: { phone: { type: "string", description: "Mobile number as the patient typed it, e.g. 01711223344" } },
    required: ["phone"],
  },
  schema: z.object({ phone: z.string().trim().min(8).max(20) }),
  run: async ({ phone }, ctx) => {
    const conv = ctx.conversation;
    // WhatsApp: the sender's own number is already known and cannot be swapped for another
    if (conv.verifiedPhone) return { summary: "phone already known", data: { status: "already_set" } };
    const e164 = toE164Bd(phone);
    if (!e164)
      throw new AppError(400, "That is not a valid Bangladeshi mobile number (01XXXXXXXXX).", "VALIDATION_ERROR");
    if (conv.phone !== e164) {
      // A different number starts fresh: nothing added or booked under the old number carries over
      conv.phone = e164;
      conv.linkedPatientIds = [];
      conv.chatAppointmentIds = [];
      conv.pendingAction = null;
      conv.markModified("pendingAction");
      await conv.save();
    }
    return {
      summary: "phone saved",
      data: { status: "saved", note: "Now ask for the patient's name, age and gender, then call register_patient." },
    };
  },
});

export const listMyPatients = defineTool({
  name: "list_my_patients",
  description:
    "Patients this chat can book for (WhatsApp: everyone on the sender's number; web: patients added in this chat).",
  parameters: { type: "object", properties: {} },
  schema: z.object({}).passthrough(),
  needsPhone: true,
  run: async (_args, ctx) => {
    if (ctx.conversation.verifiedPhone) await linkPatients(ctx.conversation);
    const patients = await PatientModel.find(myPatientsFilter(ctx.conversation)).sort({ createdAt: 1 }).lean<any[]>();
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
    "Add the patient (or a family member) on the saved phone. Only after the patient gave name, gender and age. " +
    "If the same person is already registered on that phone, their existing record is used.",
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
  needsPhone: true,
  run: async ({ name, gender, age }, ctx) => {
    const conv = ctx.conversation;
    const link = async (id: unknown) => {
      if (conv.verifiedPhone) await linkPatients(conv);
      else if (!conv.linkedPatientIds.some((p) => String(p) === String(id))) conv.linkedPatientIds.push(id as any);
      await conv.save();
    };
    try {
      const p = await createPatient(
        { name, gender, ageYears: age, phone: contactPhone(conv)!, registrationSource: sourceOf(conv) },
        {},
      );
      await link(p._id);
      return { summary: "patient registered", data: { registered: true, patient: patientForModel(conv, p) } };
    } catch (err) {
      // Same phone + similar name already exists → use that record instead of creating a duplicate
      if (err instanceof AppError && err.code === "DUPLICATE_KEY") {
        const existing = (err.details as { possibleDuplicates: { id: string }[] }).possibleDuplicates[0];
        const p = await PatientModel.findById(existing.id).lean<any>();
        await link(p._id);
        return {
          summary: "already registered",
          data: { registered: false, alreadyExists: true, patient: patientForModel(conv, p) },
        };
      }
      throw err;
    }
  },
});
