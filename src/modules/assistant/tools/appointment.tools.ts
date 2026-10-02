/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomBytes } from "crypto";
import { z } from "zod";
import AppError from "../../../errors/AppError";
import { publish } from "../../../events/bus";
import { DATE_PATTERN, addDays, nowMinutesInDhaka, toMinutes, todayInDhaka } from "../../../utils/date";
import { AppointmentModel } from "../../hospital/appointment/appointment.model";
import {
  bookAppointment,
  cancelAppointment,
  estimateFee,
  rescheduleAppointment,
} from "../../hospital/appointment/appointment.service";
import { getDoctorQueue } from "../../hospital/queue/queue.service";
import { getDaySlotsFor, loadActiveDoctor } from "../../hospital/scheduling/scheduling.service";
import { getSettings } from "../../hospital/settings/settings.service";
import { LabOrderModel } from "../../clinical/lab/labOrder.model";
import type { OutboundMessage } from "../assistant.types";
import type { ConversationDocument, PendingAction } from "../conversation.model";
import { registerInteraction } from "../interactions";
import { refFor, resolveRef } from "../refs";
import {
  dateLabel,
  firstName,
  myAppointmentsFilter,
  ownedAppointment,
  ownedPatient,
  sourceOf,
  taka,
  time12,
} from "./shared";
import { defineTool } from "./types";

/**
 * BOOK / CANCEL / RESCHEDULE follow the same two-step pattern:
 *   1. the tool validates everything (ownership, slot free, cut-off) and stores a PENDING ACTION,
 *      returning a summary card with Confirm / Change buttons;
 *   2. only the patient's Confirm (a button, or a clear "yes" in text) executes it — in code, through
 *      the SAME booking service reception uses. The model can never complete an action by itself.
 */

const PENDING_TTL_MS = 10 * 60 * 1000;
const ACTIVE = ["booked", "checked_in", "in_consultation"];

const confirmActions = (id: string, changeLabel = "✏️ বদলান · Change") => [
  { id: `confirm|${id}`, label: "✅ নিশ্চিত করুন · Confirm" },
  { id: `change|${id}`, label: changeLabel },
];

const setPending = async (
  conv: ConversationDocument,
  type: PendingAction["type"],
  payload: Record<string, unknown>,
) => {
  const pending: PendingAction = {
    id: randomBytes(6).toString("hex"),
    type,
    payload,
    expiresAt: new Date(Date.now() + PENDING_TTL_MS),
  };
  conv.pendingAction = pending;
  conv.markModified("pendingAction");
  await conv.save();
  return pending;
};

/** The next serial of the day: its place in the queue gives the estimated time. Patients never pick a time. */
const nextSerialSlot = async (doctorId: string, date: string) => {
  const doctor = await loadActiveDoctor(doctorId);
  const day = await getDaySlotsFor(doctor, date);
  const slot = day.slots.find((s) => s.available);
  if (day.onLeave || !day.sessions.length || !slot)
    throw new AppError(409, "No serial left for this doctor on that date. Offer another date.", "CONFLICT");
  const session = day.sessions.find((s) => s.sessionKey === slot.sessionKey)!;
  return { doctor: doctor as any, slot, session };
};

const sittingOf = (s: { labelBn: string; startTime: string; endTime: string }) =>
  `${s.labelBn} ${time12(s.startTime)} – ${time12(s.endTime)}`;

// ------------------------------------------------------------------ tools

export const bookAppointmentTool = defineTool({
  name: "book_appointment",
  description:
    "PREPARE a booking (the next serial of that day) for one of the patient's own patients (P-reference). " +
    "Shows a summary with Confirm; it is booked only when the patient confirms. There is no time to choose.",
  parameters: {
    type: "object",
    properties: {
      patientRef: { type: "string", description: "P-reference from list_my_patients / register_patient" },
      doctorId: { type: "string" },
      date: { type: "string", description: "YYYY-MM-DD" },
    },
    required: ["patientRef", "doctorId", "date"],
  },
  schema: z.object({
    patientRef: z.string().trim().max(5),
    doctorId: z.string().regex(/^[a-f\d]{24}$/i, "unknown doctor"),
    date: z.string().regex(DATE_PATTERN),
  }),
  needsPhone: true,
  run: async ({ patientRef, doctorId, date }, ctx) => {
    const conv = ctx.conversation;
    const patient = await ownedPatient(conv, patientRef);
    const { doctor, slot, session } = await nextSerialSlot(doctorId, date);
    const { fee, type } = await estimateFee(String(patient._id), doctor, date);
    const pending = await setPending(conv, "book", { patientId: String(patient._id), doctorId, date });
    const card: OutboundMessage = {
      type: "card",
      kind: "booking_summary",
      title: "সিরিয়াল নিশ্চিত করুন · Please confirm",
      fields: [
        { label: "রোগী · Patient", value: patient.name },
        { label: "ডাক্তার · Doctor", value: `${doctor.title ?? ""} ${doctor.name}`.trim() },
        { label: "বিভাগ · Department", value: doctor.department?.name ?? "" },
        { label: "তারিখ · Date", value: dateLabel(date) },
        { label: "ডাক্তার বসবেন · Sitting", value: sittingOf(session) },
        { label: "আনুমানিক সময় · Estimated time", value: `~${time12(slot.time)}` },
        { label: "ফি · Fee", value: `${taka(fee)}${type === "follow_up" ? " (follow-up)" : ""}` },
      ],
      actions: confirmActions(pending.id),
    };
    return {
      summary: "awaiting confirmation",
      data: {
        status: "awaiting_confirmation",
        estimatedTime: time12(slot.time),
        note: "Ask the patient to press Confirm. The serial number is given after Confirm.",
      },
      ui: [card],
    };
  },
});

export const getMyAppointments = defineTool({
  name: "get_my_appointments",
  description: "Upcoming appointments this chat can see (A-references).",
  parameters: { type: "object", properties: {} },
  schema: z.object({}).passthrough(),
  needsPhone: true,
  run: async (_args, ctx) => {
    const conv = ctx.conversation;
    const rows = await AppointmentModel.find({
      ...myAppointmentsFilter(conv),
      date: { $gte: todayInDhaka() },
      status: { $in: ACTIVE },
    })
      .sort({ date: 1, slotTime: 1 })
      .limit(5)
      .populate("patient", "name")
      .populate("doctor", "title name roomNo")
      .populate("department", "name")
      .lean<any[]>();
    const items = rows.map((a) => ({
      ref: refFor(conv, "A", String(a._id)),
      patient: firstName(a.patient.name),
      doctor: `${a.doctor.title ?? ""} ${a.doctor.name}`.trim(),
      department: a.department?.name,
      date: a.date,
      time: time12(a.slotTime),
      serialNo: a.serialNo,
      status: a.status,
    }));
    return {
      summary: `${items.length} appointments`,
      data: items.length ? items : { found: 0 },
      ui: items.length
        ? [
            {
              type: "list",
              kind: "appointments",
              text: "আপনার অ্যাপয়েন্টমেন্ট · Your appointments",
              button: "দেখুন",
              items: rows.map((a, i) => ({
                id: `appt|${items[i].ref}`,
                label: `${dateLabel(a.date)} ${time12(a.slotTime)} · Serial ${a.serialNo}`,
                description: `${a.patient.name} · ${items[i].doctor}`,
              })),
            },
          ]
        : [],
    };
  },
});

export const cancelAppointmentTool = defineTool({
  name: "cancel_appointment",
  description: "PREPARE cancelling one of the patient's appointments (A-reference). Needs the patient's Confirm.",
  parameters: {
    type: "object",
    properties: { appointmentRef: { type: "string" } },
    required: ["appointmentRef"],
  },
  schema: z.object({ appointmentRef: z.string().trim().max(5) }),
  needsPhone: true,
  run: async ({ appointmentRef }, ctx) => {
    const appt = await ownedAppointment(ctx.conversation, appointmentRef);
    if (!["booked", "checked_in"].includes(appt.status))
      throw new AppError(
        409,
        `This appointment is "${appt.status.replace("_", " ")}" and cannot be cancelled.`,
        "CONFLICT",
      );
    const { cancellationCutoffMinutes } = await getSettings();
    if (appt.date === todayInDhaka() && toMinutes(appt.slotTime) - nowMinutesInDhaka() < cancellationCutoffMinutes)
      throw new AppError(
        409,
        `It is too late to cancel online (less than ${cancellationCutoffMinutes} minutes before). Please call the hospital.`,
        "CONFLICT",
      );
    const pending = await setPending(ctx.conversation, "cancel", { appointmentId: String(appt._id) });
    return {
      summary: "awaiting confirmation",
      data: { status: "awaiting_confirmation" },
      ui: [
        {
          type: "card",
          kind: "cancel_summary",
          title: "বাতিল নিশ্চিত করুন · Cancel this appointment?",
          fields: [
            { label: "রোগী · Patient", value: appt.patient.name },
            { label: "ডাক্তার · Doctor", value: `${appt.doctor.title ?? ""} ${appt.doctor.name}`.trim() },
            { label: "তারিখ · Date", value: `${dateLabel(appt.date)} ${time12(appt.slotTime)}` },
            { label: "সিরিয়াল · Serial", value: String(appt.serialNo) },
          ],
          actions: confirmActions(pending.id, "↩️ রাখুন · Keep it"),
        },
      ],
    };
  },
});

export const rescheduleAppointmentTool = defineTool({
  name: "reschedule_appointment",
  description:
    "PREPARE moving one of the patient's appointments (A-reference) to a new date with the same doctor " +
    "(the next serial of that date). Needs the patient's Confirm.",
  parameters: {
    type: "object",
    properties: {
      appointmentRef: { type: "string" },
      newDate: { type: "string", description: "YYYY-MM-DD" },
    },
    required: ["appointmentRef", "newDate"],
  },
  schema: z.object({
    appointmentRef: z.string().trim().max(5),
    newDate: z.string().regex(DATE_PATTERN),
  }),
  needsPhone: true,
  run: async ({ appointmentRef, newDate }, ctx) => {
    const appt = await ownedAppointment(ctx.conversation, appointmentRef);
    if (!["booked", "checked_in"].includes(appt.status))
      throw new AppError(409, `A "${appt.status.replace("_", " ")}" appointment cannot be moved.`, "CONFLICT");
    const { slot } = await nextSerialSlot(String(appt.doctor._id), newDate);
    const pending = await setPending(ctx.conversation, "reschedule", {
      appointmentId: String(appt._id),
      date: newDate,
    });
    return {
      summary: "awaiting confirmation",
      data: { status: "awaiting_confirmation" },
      ui: [
        {
          type: "card",
          kind: "reschedule_summary",
          title: "সময় বদল নিশ্চিত করুন · Confirm the new time",
          fields: [
            { label: "রোগী · Patient", value: appt.patient.name },
            { label: "ডাক্তার · Doctor", value: `${appt.doctor.title ?? ""} ${appt.doctor.name}`.trim() },
            { label: "আগে · Was", value: `${dateLabel(appt.date)} ${time12(appt.slotTime)}` },
            { label: "নতুন · New", value: `${dateLabel(newDate)} · আনুমানিক ~${time12(slot.time)}` },
          ],
          actions: confirmActions(pending.id),
        },
      ],
    };
  },
});

export const getQueueStatus = defineTool({
  name: "get_queue_status",
  description:
    "Today's live queue for one of the patient's appointments (A-reference, or omit for today's appointment): " +
    "current serial, their serial, people ahead, estimated wait.",
  parameters: { type: "object", properties: { appointmentRef: { type: "string" } } },
  schema: z.object({ appointmentRef: z.string().trim().max(5).optional() }),
  needsPhone: true,
  run: async ({ appointmentRef }, ctx) => {
    const conv = ctx.conversation;
    const appt = appointmentRef
      ? await ownedAppointment(conv, appointmentRef)
      : await AppointmentModel.findOne({
          ...myAppointmentsFilter(conv),
          date: todayInDhaka(),
          status: { $in: ACTIVE },
        }).sort({ slotTime: 1 });
    if (!appt || appt.date !== todayInDhaka())
      return { summary: "no appointment today", data: { found: false, note: "No appointment today for this phone." } };

    const q = await getDoctorQueue(String(appt.doctor?._id ?? appt.doctor));
    const mine = q.waiting.find((w: any) => w.id === String(appt._id));
    const withDoctor = q.current?.id === String(appt._id);
    const aheadNotArrived = q.notArrived.filter((n: any) => n.slotTime < appt.slotTime).length;
    const ahead = withDoctor
      ? 0
      : mine
        ? mine.position - 1 + (q.current ? 1 : 0)
        : q.waiting.length + (q.current ? 1 : 0);
    const waitMinutes = withDoctor ? 0 : mine ? mine.estimatedWaitMinutes : ahead * q.doctor.averageMinutesPerPatient;
    const state = withDoctor
      ? "with_doctor"
      : mine
        ? "waiting"
        : appt.status === "booked"
          ? "not_checked_in"
          : appt.status;
    const data = {
      doctor: q.doctor.displayName,
      room: q.doctor.roomNo,
      currentSerial: q.current?.serialNo ?? null,
      yourSerial: appt.serialNo,
      peopleAhead: ahead,
      estimatedWaitMinutes: waitMinutes,
      state,
      ...(state === "not_checked_in" && {
        note: "Please check in at reception when you arrive.",
        bookedEarlierNotArrived: aheadNotArrived,
      }),
    };
    return {
      summary: `serial ${appt.serialNo}, ${ahead} ahead`,
      data,
      ui: [
        {
          type: "card",
          kind: "queue_status",
          title: "আজকের সিরিয়াল · Today's queue",
          fields: [
            {
              label: "ডাক্তার · Doctor",
              value: `${q.doctor.displayName}${q.doctor.roomNo ? ` · Room ${q.doctor.roomNo}` : ""}`,
            },
            { label: "এখন চলছে · Now serving", value: q.current ? String(q.current.serialNo) : "—" },
            { label: "আপনার সিরিয়াল · Your serial", value: String(appt.serialNo) },
            { label: "আগে আছেন · Ahead of you", value: String(ahead) },
            { label: "আনুমানিক অপেক্ষা · Est. wait", value: `~${waitMinutes} min` },
          ],
          data,
        },
      ],
    };
  },
});

const LAB_STATE: Record<string, { key: string; bn: string; en: string }> = {
  ordered: { key: "ordered", bn: "অর্ডার হয়েছে, নমুনা দেওয়া বাকি", en: "Ordered — sample not given yet" },
  sample_collected: { key: "in_progress", bn: "পরীক্ষা চলছে", en: "In progress" },
  processing: { key: "in_progress", bn: "পরীক্ষা চলছে", en: "In progress" },
  awaiting_verification: { key: "in_progress", bn: "পরীক্ষা চলছে", en: "In progress" },
  ready: {
    key: "ready",
    bn: "রিপোর্ট প্রস্তুত — হাসপাতাল থেকে সংগ্রহ করুন",
    en: "Ready — collect it from the hospital",
  },
  delivered: { key: "collected", bn: "রিপোর্ট দেওয়া হয়েছে", en: "Already collected" },
};

export const getLabReportStatus = defineTool({
  name: "get_lab_report_status",
  description:
    "STATUS of the patient's lab reports (ordered / in progress / ready). Never returns result values. " +
    "Optional L-reference for one report.",
  parameters: { type: "object", properties: { labOrderRef: { type: "string" } } },
  schema: z.object({ labOrderRef: z.string().trim().max(5).optional() }),
  needsVerifiedPhone: true, // lab tests are clinical: only on a proven number
  run: async ({ labOrderRef }, ctx) => {
    const conv = ctx.conversation;
    const oneId = labOrderRef ? resolveRef(conv, "L", labOrderRef) : null;
    const since = addDays(todayInDhaka(), -60);
    const orders = await LabOrderModel.find({
      patient: { $in: conv.linkedPatientIds }, // ownership: only this phone's patients
      status: { $ne: "cancelled" },
      date: { $gte: since },
      ...(oneId && { _id: oneId }),
    })
      .sort({ createdAt: -1 })
      .limit(3)
      .populate("patient", "name")
      .select("orderNo date status tests.name patient") // never the results
      .lean<any[]>();
    const items = orders.map((o) => ({
      ref: refFor(conv, "L", String(o._id)),
      patient: firstName(o.patient.name),
      tests: o.tests.map((t: any) => t.name),
      date: o.date,
      status: LAB_STATE[o.status]?.key ?? "in_progress",
    }));
    return {
      summary: `${items.length} lab orders`,
      data: items.length ? items : { found: 0, note: "No recent lab tests for this phone." },
      ui: orders.map((o) => ({
        type: "card" as const,
        kind: "lab_status" as const,
        title: o.tests.map((t: any) => t.name).join(", "),
        fields: [
          { label: "রোগী · Patient", value: o.patient.name },
          { label: "তারিখ · Date", value: dateLabel(o.date) },
          { label: "অবস্থা · Status", value: `${LAB_STATE[o.status]?.bn} · ${LAB_STATE[o.status]?.en}` },
        ],
        data: { status: LAB_STATE[o.status]?.key },
      })),
    };
  },
});

// ------------------------------------------------------------------ confirmation (in code, never the model)

const YES =
  /^\s*(yes|y|ok|okay|confirm|sure|হ্যাঁ|হা|হ্যা|জি|জ্বি|ঠিক আছে|নিশ্চিত|ha+|hya|ji+|jee|thik ache)\s*[.!]*\s*$/i;

const bookingSuccess = (a: any): OutboundMessage => ({
  type: "card",
  kind: "booking_success",
  title: `সিরিয়াল ${a.serialNo} নিশ্চিত হয়েছে · Booked`,
  fields: [
    { label: "সিরিয়াল · Serial", value: String(a.serialNo) },
    { label: "রোগী · Patient", value: a.patient.name },
    { label: "ডাক্তার · Doctor", value: a.doctor.displayName },
    { label: "রুম · Room", value: a.doctor.roomNo ?? "—" },
    { label: "তারিখ · Date", value: dateLabel(a.date) },
    { label: "আনুমানিক সময় · Estimated time", value: `~${time12(a.slotTime)}` },
  ],
  data: {
    serialNo: a.serialNo,
    date: a.date,
    time: a.slotTime,
    doctor: a.doctor.displayName,
    room: a.doctor.roomNo ?? null,
    note:
      "The time is an estimate from the serials before you. Please arrive 15 minutes early and check in at reception. · " +
      "সময়টি আনুমানিক, আগের রোগীদের উপর নির্ভর করে। ১৫ মিনিট আগে এসে রিসেপশনে জানান।",
  },
});

/** Friendly error when booking failed at Confirm (e.g. the day filled up in between) */
const failureMessages = (err: unknown): OutboundMessage[] => {
  const msg = err instanceof AppError ? err.message : "Sorry, that did not work. Please try again.";
  return [{ type: "text", text: `⚠️ ${msg}` }];
};

const execute = async (conv: ConversationDocument, pending: PendingAction): Promise<OutboundMessage[]> => {
  const actor = { label: `assistant:${conv.channel}` };
  const p = pending.payload as Record<string, string>;
  if (pending.type === "book") {
    const patient = await ownedPatient(conv, refFor(conv, "P", p.patientId)); // re-check ownership
    const { slot } = await nextSerialSlot(p.doctorId, p.date); // the next serial NOW, not at summary time
    const a = await bookAppointment(
      {
        patientId: String(patient._id),
        doctorId: p.doctorId,
        date: p.date,
        slotTime: slot.time,
        source: sourceOf(conv),
        chatSessionId: String(conv._id),
      },
      actor,
    );
    conv.chatAppointmentIds.push(a.id as any);
    conv.metrics.bookingsCreated += 1;
    void publish("chat.booking_created", {
      conversationId: String(conv._id),
      appointmentId: a.id,
      patientId: String(patient._id),
      channel: conv.channel,
    });
    return [bookingSuccess(a)];
  }
  const appt = await ownedAppointment(conv, refFor(conv, "A", p.appointmentId)); // re-check ownership
  if (pending.type === "cancel") {
    const { cancellationCutoffMinutes } = await getSettings();
    await cancelAppointment(String(appt._id), "Cancelled by the patient via the assistant", actor, {
      enforceCutoffMinutes: cancellationCutoffMinutes,
    });
    return [
      {
        type: "card",
        kind: "cancel_success",
        title: "অ্যাপয়েন্টমেন্ট বাতিল হয়েছে · Cancelled",
        fields: [{ label: "তারিখ · Date", value: `${dateLabel(appt.date)} ${time12(appt.slotTime)}` }],
        // Offer the next free times with the same doctor right away (handled by automation replies)
        actions: [{ id: `auto|rebook|${appt._id}`, label: "নতুন সময় নিন · New time" }],
      },
    ];
  }
  const { slot } = await nextSerialSlot(String(appt.doctor._id), p.date);
  const moved = await rescheduleAppointment(String(appt._id), { date: p.date, slotTime: slot.time }, actor);
  return [bookingSuccess(moved)];
};

registerInteraction(async (conv, replyId, text) => {
  const pending = conv.pendingAction;
  const [kind, id] = replyId.split("|");
  // A button from an older summary: never act on it
  if ((kind === "confirm" || kind === "change") && (!pending || id !== pending.id))
    return {
      messages: [
        { type: "text", text: "এই সারাংশটি আর বৈধ নয়। আবার চেষ্টা করুন। · That summary is no longer valid." },
      ],
    };
  if (!pending) return null;
  const isConfirm = (kind === "confirm" && id === pending.id) || (!replyId && YES.test(text ?? ""));
  const isChange = kind === "change" && id === pending.id;
  if (!isConfirm && !isChange) return null;

  conv.pendingAction = null;
  conv.markModified("pendingAction");
  if (isChange || new Date(pending.expiresAt).getTime() < Date.now()) {
    await conv.save();
    return {
      messages: [
        {
          type: "text",
          text: isChange
            ? "ঠিক আছে, কী বদলাতে চান — তারিখ, সময় নাকি ডাক্তার? · Sure — what would you like to change?"
            : "সময় পার হয়ে গেছে, আবার চেষ্টা করুন। · That summary expired, let's try again.",
        },
      ],
    };
  }
  try {
    const messages = await execute(conv, pending);
    await conv.save();
    return { messages };
  } catch (err) {
    await conv.save();
    return { messages: failureMessages(err) };
  }
});
