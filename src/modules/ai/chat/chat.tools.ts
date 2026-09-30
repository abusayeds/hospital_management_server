/* eslint-disable @typescript-eslint/no-explicit-any */
import { FunctionDeclaration } from "@google/genai";
import { emitToPermission } from "../../../sockets";
import { DepartmentModel } from "../../hospital/department/department.model";
import { searchDoctorsByText } from "../../hospital/doctor/doctor.service";
import { assistantBook, assistantFindAppointments, assistantSlots } from "./chat.booking";
import { ChatSessionModel } from "./chat.model";

// Tools the AI can call. The model never invents doctors, fees or slots:
// it must fetch them from the database through these functions.
export const toolDeclarations: FunctionDeclaration[] = [
  {
    name: "list_departments",
    description: "List all hospital departments (English and Bangla names).",
    parametersJsonSchema: { type: "object", properties: {} },
  },
  {
    name: "search_doctors",
    description:
      "Find active doctors with their id, department, specialty, fee, room and weekly schedule. " +
      "Filter by department name (English or Bangla) and/or doctor name. Call with no filters to list all doctors.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        department: { type: "string", description: "Department name, e.g. 'Medicine', 'Cardiology', 'শিশু'" },
        name: { type: "string", description: "Part of the doctor's name" },
      },
    },
  },
  {
    name: "get_available_slots",
    description: "Get free appointment slots of a doctor on a given date.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        doctor_id: { type: "string", description: "Doctor id from search_doctors" },
        date: { type: "string", description: "Date in YYYY-MM-DD format" },
      },
      required: ["doctor_id", "date"],
    },
  },
  {
    name: "book_appointment",
    description:
      "Book an appointment. Only call AFTER showing the patient a summary (doctor, date, time, name, age, phone) " +
      "and the patient has explicitly confirmed. Existing patients are matched by phone and name; new ones are registered.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        doctor_id: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD" },
        slot_time: { type: "string", description: "HH:mm, must be one of the available slots" },
        patient_name: { type: "string" },
        phone: { type: "string", description: "Bangladeshi mobile number, 01XXXXXXXXX" },
        age: { type: "integer", description: "Age in years" },
        gender: { type: "string", enum: ["male", "female", "other"] },
        reason: { type: "string", description: "Short reason for visit in the patient's words" },
      },
      required: ["doctor_id", "date", "slot_time", "patient_name", "phone", "age", "gender"],
    },
  },
  {
    name: "find_my_appointments",
    description:
      "Find the upcoming appointments of the patient in this chat. Needs BOTH their mobile number and their name (for privacy).",
    parametersJsonSchema: {
      type: "object",
      properties: { phone: { type: "string" }, patient_name: { type: "string" } },
      required: ["phone", "patient_name"],
    },
  },
  {
    name: "handoff_to_human",
    description:
      "Alert hospital staff to contact this patient. Use for emergencies, complaints, billing/report questions, " +
      "or when the patient asks for a human.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        reason: { type: "string" },
        urgency: { type: "string", enum: ["emergency", "normal"] },
      },
      required: ["reason", "urgency"],
    },
  },
];

export type TToolContext = {
  sessionId: string;
  bookedAppointments: any[];
  handoff?: { reason: string; urgency: string };
};

export const executeTool = async (name: string, args: any, ctx: TToolContext): Promise<unknown> => {
  switch (name) {
    case "list_departments":
      return (await DepartmentModel.find({ isActive: true }).sort({ displayOrder: 1, name: 1 })).map((d: any) => ({
        name: d.name,
        nameBn: d.nameBn,
      }));

    case "search_doctors":
      return searchDoctorsByText({ department: args?.department, name: args?.name });

    case "get_available_slots":
      return assistantSlots(args.doctor_id, args.date);

    case "book_appointment": {
      const appointment = await assistantBook(args, ctx.sessionId);
      ctx.bookedAppointments.push(appointment);
      return appointment;
    }

    case "find_my_appointments":
      return assistantFindAppointments(args.phone, args.patient_name);

    case "handoff_to_human": {
      ctx.handoff = { reason: String(args.reason), urgency: String(args.urgency) };
      await ChatSessionModel.updateOne(
        { sessionId: ctx.sessionId },
        {
          needsHuman: true,
          handoffReason: ctx.handoff.reason,
          ...(args.urgency === "emergency" && { emergency: true }),
        },
      );
      emitToPermission("assistant_chat:manage", "chat:handoff", { sessionId: ctx.sessionId, ...ctx.handoff });
      return { ok: true, message: "Staff has been notified and will contact the patient." };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
};
