import AppError from "../../../errors/AppError";
import { logger } from "../../../utils/logger";
import type { AiToolCall, AiToolDef } from "../../../ai/provider";
import type { ToolCallLog } from "../chatMessage.model";
import {
  bookAppointmentTool,
  cancelAppointmentTool,
  getLabReportStatus,
  getMyAppointments,
  getQueueStatus,
  rescheduleAppointmentTool,
} from "./appointment.tools";
import { getAvailableSlots, getTestPreparation, searchDoctors } from "./doctor.tools";
import { listMyPatients, registerPatientTool, startVerificationTool, verifyCodeTool } from "./identity.tools";
import { getHospitalInfo, listDepartments, requestHuman } from "./info.tools";
import { searchKnowledgeBase } from "./knowledge.tools";
import type { AssistantTool, ToolContext } from "./types";

/** Every tool the assistant may call. Order = how they are listed to the model. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each tool has its own argument schema
export const ASSISTANT_TOOLS: AssistantTool<any>[] = [
  getHospitalInfo,
  searchKnowledgeBase,
  listDepartments,
  searchDoctors,
  getAvailableSlots,
  getTestPreparation,
  startVerificationTool,
  verifyCodeTool,
  listMyPatients,
  registerPatientTool,
  bookAppointmentTool,
  getMyAppointments,
  cancelAppointmentTool,
  rescheduleAppointmentTool,
  getQueueStatus,
  getLabReportStatus,
  requestHuman,
];

// Tools with side effects are not run from the admin's "test the assistant" panel
const PREVIEW_BLOCKED = new Set(["request_human", "start_verification", "verify_code"]);

const byName = new Map(ASSISTANT_TOOLS.map((t) => [t.name, t]));

export const toolDefinitions = (): AiToolDef[] =>
  ASSISTANT_TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));

// Tool arguments are stored for transparency, but never phone numbers or codes in clear text
const SENSITIVE_ARG = /phone|code|otp|name/i;
export const sanitizeArgs = (args: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(args).map(([k, v]) => [
      k,
      SENSITIVE_ARG.test(k) ? "[hidden]" : typeof v === "string" ? v.slice(0, 80) : v,
    ]),
  );

/**
 * Run one tool call from the model. Never throws: invalid arguments, missing verification and
 * business errors come back as { error } for the model to explain in plain words.
 */
export const runTool = async (call: AiToolCall, ctx: ToolContext): Promise<{ result: unknown; log: ToolCallLog }> => {
  const started = Date.now();
  const tool = byName.get(call.name);
  const finish = (result: unknown, success: boolean, summary: string) => ({
    result,
    log: {
      name: call.name,
      arguments: sanitizeArgs(call.args ?? {}),
      resultSummary: summary.slice(0, 200),
      success,
      latencyMs: Date.now() - started,
    },
  });

  if (!tool) return finish({ error: `Unknown tool ${call.name}` }, false, "unknown tool");
  const parsed = tool.schema.safeParse(call.args ?? {});
  if (!parsed.success)
    return finish(
      {
        error: "Invalid arguments",
        details: parsed.error.issues.map(
          (i: { path: (string | number)[]; message: string }) => `${i.path.join(".")}: ${i.message}`,
        ),
      },
      false,
      "invalid arguments",
    );
  if (ctx.preview && PREVIEW_BLOCKED.has(tool.name))
    return finish({ error: "Not available in the test panel." }, false, "blocked in preview");
  if (tool.needsVerification && !ctx.conversation.verifiedPhone)
    return finish(
      {
        error: "not_verified",
        instruction: "Ask the patient for their mobile number and call start_verification first.",
      },
      false,
      "verification required",
    );

  try {
    const out = await tool.run(parsed.data, ctx);
    if (out.ui) ctx.ui.push(...out.ui);
    return finish(out.data, true, out.summary);
  } catch (err) {
    if (err instanceof AppError && err.statusCode < 500)
      return finish({ error: err.message, details: err.details }, false, err.message);
    logger.error({ err, tool: call.name }, "Assistant tool failed");
    return finish(
      { error: "Something went wrong while checking. Offer the hospital phone number." },
      false,
      "tool error",
    );
  }
};
