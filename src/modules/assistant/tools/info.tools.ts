import { z } from "zod";
import { DepartmentModel } from "../../hospital/department/department.model";
import { getSettings } from "../../hospital/settings/settings.service";
import { requestHandover } from "../handover";
import { defineTool } from "./types";

const noArgs = { type: "object", properties: {} };

export const getHospitalInfo = defineTool({
  name: "get_hospital_info",
  description: "Hospital name, address, phone numbers, emergency number, opening hours and the list of departments.",
  parameters: noArgs,
  schema: z.object({}).passthrough(),
  run: async () => {
    const [s, departments] = await Promise.all([
      getSettings(),
      DepartmentModel.find({ isActive: true })
        .sort({ displayOrder: 1, name: 1 })
        .lean<{ name: string; nameBn?: string }[]>(),
    ]);
    return {
      summary: "hospital info",
      data: {
        name: s.name,
        nameBn: s.nameBn,
        address: s.address,
        addressBn: s.addressBn,
        phones: s.phones,
        emergencyPhone: s.emergencyPhone,
        nationalEmergency: "999",
        openingHours: s.openingHours,
        openingHoursBn: s.openingHoursBn,
        departments: departments.map((d) => d.name),
      },
    };
  },
});

export const listDepartments = defineTool({
  name: "list_departments",
  description: "List the hospital's departments with Bangla and English names.",
  parameters: noArgs,
  schema: z.object({}).passthrough(),
  run: async () => {
    const departments = await DepartmentModel.find({ isActive: true })
      .sort({ displayOrder: 1, name: 1 })
      .lean<{ _id: unknown; name: string; nameBn?: string }[]>();
    return {
      summary: `${departments.length} departments`,
      data: departments.map((d) => ({ name: d.name, nameBn: d.nameBn })),
      ui: [
        {
          type: "list",
          kind: "departments",
          text: "বিভাগসমূহ · Departments",
          button: "বিভাগ দেখুন",
          items: departments.slice(0, 10).map((d) => ({
            id: `dept|${d.name}`,
            label: d.nameBn ? `${d.nameBn} · ${d.name}` : d.name,
          })),
        },
      ],
    };
  },
});

export const requestHuman = defineTool({
  name: "request_human",
  description:
    "Ask a hospital staff member to take over this conversation (the patient asks for a person, a complaint, " +
    "billing, something you cannot answer, or a danger sign).",
  parameters: {
    type: "object",
    properties: { reason: { type: "string", description: "Short reason, e.g. 'wants to talk to a person'" } },
    required: ["reason"],
  },
  schema: z.object({ reason: z.string().trim().min(1).max(200) }),
  run: async ({ reason }, ctx) => {
    await requestHandover(ctx.conversation, reason);
    return {
      summary: "handed to staff",
      data: { status: "staff_notified", note: "Tell the patient a staff member will reply here soon." },
      ui: [
        {
          type: "handover",
          text: "একজন স্টাফকে জানানো হয়েছে, শীঘ্রই এখানে উত্তর দেবেন। · A staff member will reply here soon.",
        },
      ],
    };
  },
});
