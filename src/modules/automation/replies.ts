/* eslint-disable @typescript-eslint/no-explicit-any */
import { Types } from "mongoose";
import AppError from "../../errors/AppError";
import { addDays } from "../../utils/date";
import { logger } from "../../utils/logger";
import { recordAudit } from "../audit/audit.service";
import type { OutboundMessage, ReplyOption } from "../assistant/assistant.types";
import type { ConversationDocument } from "../assistant/conversation.model";
import { registerInteraction } from "../assistant/interactions";
import { refFor } from "../assistant/refs";
import { cancelAppointmentTool, getQueueStatus, rescheduleAppointmentTool } from "../assistant/tools/appointment.tools";
import { getAvailableSlots } from "../assistant/tools/doctor.tools";
import type { ToolContext } from "../assistant/tools/types";
import { LabOrderModel } from "../clinical/lab/labOrder.model";
import { VisitModel } from "../clinical/visits/visit.model";
import { AppointmentModel } from "../hospital/appointment/appointment.model";
import { PatientModel } from "../patients/patient.model";
import { OutboxMessageModel } from "./models/outbox.model";
import { dhakaDate, formatDateFor, formatTimeFor } from "./time";
import { renderTemplate } from "./templates/render";
import { getTemplate } from "./templates/template.service";

/**
 * REPLIES TO AUTOMATED MESSAGES. Buttons on reminders carry "auto|<action>|<id>". A reply (tapped, or
 * typed like "Cancel" / "বাতিল" / "2" within 48 hours of the message) is routed here BEFORE the model:
 *   confirm    → appointment.confirmedByPatient (ownership checked against the verified phone)
 *   reschedule → free slots of the same doctor → the chatbot's own reschedule tool (summary + Confirm)
 *   cancel     → the chatbot's own cancel tool (summary + Confirm → existing cancel service)
 *   rebook/book→ free slots of the right doctor → the normal booking flow
 *   queue      → the chatbot's queue-status tool
 *   stop/STOP  → opt out of all non-essential messages · START → opt back in
 * Nothing here books or cancels by itself — it only opens the existing, confirmed flows.
 * Anything else (free text) goes on to the normal chatbot.
 */

const REPLY_WINDOW_MS = 48 * 60 * 60 * 1000;

const STOP =
  /^\s*(stop|unsubscribe|stop all|বন্ধ|বন্ধ করুন|মেসেজ বন্ধ|আর মেসেজ দিবেন না|don'?t contact me)\s*[.!]*\s*$/i;
const START = /^\s*(start|subscribe|চালু|চালু করুন)\s*[.!]*\s*$/i;

// Typed answers to the buttons of the last automated message
const WORDS: Record<string, RegExp> = {
  confirm: /^(confirm|i'?ll come|i will come|আসছি|নিশ্চিত|নিশ্চিত করছি)$/i,
  reschedule: /^(reschedule|change time|সময় বদলাব|সময় বদল)$/i,
  cancel: /^(cancel|can'?t come|বাতিল|বাতিল করব|আসতে পারব না)$/i,
  rebook: /^(rebook|নতুন সময় নেব)$/i,
  book: /^(book|book now|সিরিয়াল নেব)$/i,
  not_now: /^(not now|later|এখন না)$/i,
};

const text = (t: string): OutboundMessage => ({ type: "text", text: t });
const lang = (conv: ConversationDocument): "bn" | "en" => (conv.language === "en" ? "en" : "bn");

/** The most recent automated message with buttons sent to this phone in the last 48 hours */
const recentAutomated = (phone: string) =>
  OutboxMessageModel.findOne({
    toRef: phone,
    source: "automation",
    "interactive.buttons.0": { $exists: true },
    createdAt: { $gte: new Date(Date.now() - REPLY_WINDOW_MS) },
  }).sort({ createdAt: -1 });

/** Typed text → the button it means (word or 1 / 2 / 3) */
const typedButton = (row: any, typed: string) => {
  const t = typed.trim().toLowerCase();
  const buttons: { id: string; label: string }[] = row?.interactive?.buttons ?? [];
  const byNumber = /^[1-3]$/.test(t) ? buttons[Number(t) - 1] : undefined;
  return (
    byNumber ??
    buttons.find((b) => b.label.trim().toLowerCase() === t) ??
    buttons.find((b) => WORDS[b.id.split("|")[1]]?.test(t))
  );
};

const markReplied = async (phone: string | null | undefined, replyId: string, action: string) => {
  if (!phone) return null;
  const row = await OutboxMessageModel.findOne({
    toRef: phone,
    "interactive.buttons.id": replyId,
    createdAt: { $gte: new Date(Date.now() - REPLY_WINDOW_MS) },
  }).sort({ createdAt: -1 });
  if (row)
    await OutboxMessageModel.updateOne({ _id: row._id }, { $set: { repliedAt: new Date(), replyAction: action } });
  return row;
};

const toolCtx = (conv: ConversationDocument): ToolContext => ({ conversation: conv, ui: [], bookedAppointmentIds: [] });

/** Business errors (not yours, too late to cancel …) become a friendly line; anything else is logged */
const friendly = (err: unknown): OutboundMessage[] => {
  if (err instanceof AppError) return [text(`⚠️ ${err.message}`)];
  logger.error({ err: (err as Error).message }, "Automation reply failed");
  return [text("দুঃখিত, এখন করা গেল না। একটু পরে আবার চেষ্টা করুন। · Sorry, that did not work. Please try again.")];
};

// ------------------------------------------------------------------ opt-out / opt-in

export const setOptOut = async (phone: string, optOut: boolean, reason: string) => {
  const patients = await PatientModel.find({ phone }).select("_id").lean<any[]>();
  await PatientModel.updateMany(
    { phone },
    optOut
      ? {
          $set: {
            "preferences.optOutAll": true,
            "preferences.optOutAt": new Date(),
            "preferences.optOutReason": reason,
          },
        }
      : { $set: { "preferences.optOutAll": false, "preferences.optOutAt": null, "preferences.optOutReason": null } },
  );
  for (const p of patients)
    await recordAudit({
      action: "UPDATE",
      entityType: "Patient",
      entityId: p._id,
      after: { optOutAll: optOut, reason },
      meta: { by: "patient reply" },
    });
  return patients.length;
};

const optOutReply = async (l: "bn" | "en") => {
  const tpl = await getTemplate("opt_out_confirmed");
  return renderTemplate(tpl, l, {}).text;
};

// ------------------------------------------------------------------ slot offers (reusing the chatbot's slot tool)

/** Free times of one doctor on the first day (from `from`, up to a week) that has any */
const slotOffer = async (doctorId: string, from: string, skipDate?: string) => {
  for (let i = 0; i < 7; i++) {
    const date = addDays(from, i);
    if (date === skipDate) continue;
    const out = await getAvailableSlots.run({ doctorId, date }, {} as ToolContext);
    const list = out.ui?.find((m) => m.type === "list");
    if (list && list.type === "list" && list.items.length) return { date, list };
  }
  return null;
};

const ownedAppointmentById = async (conv: ConversationDocument, id: string) => {
  if (!Types.ObjectId.isValid(id)) throw new AppError(400, "Unknown appointment.");
  const a = await AppointmentModel.findById(id)
    .populate("patient", "phone")
    .populate("doctor", "title name")
    .lean<any>();
  if (!a || !conv.verifiedPhone || a.patient?.phone !== conv.verifiedPhone)
    throw new AppError(403, "That appointment does not belong to this phone number.", "FORBIDDEN");
  return a;
};

/** Which doctor a "Book" button means: the appointment's, the visit's or the lab order's doctor */
const doctorForRef = async (conv: ConversationDocument, id: string): Promise<string | null> => {
  if (!Types.ObjectId.isValid(id)) return null;
  const owned = async (patientId: unknown) =>
    (await PatientModel.findById(patientId).select("phone").lean<any>())?.phone === conv.verifiedPhone;
  const appt = await AppointmentModel.findById(id).select("patient doctor").lean<any>();
  if (appt) return (await owned(appt.patient)) ? String(appt.doctor) : null;
  const visit = await VisitModel.findById(id).select("patient doctor").lean<any>();
  if (visit) return (await owned(visit.patient)) ? String(visit.doctor) : null;
  const order = await LabOrderModel.findById(id).select("patient doctor").lean<any>();
  if (order?.doctor) return (await owned(order.patient)) ? String(order.doctor) : null;
  return null;
};

// ------------------------------------------------------------------ actions

type Action = "confirm" | "reschedule" | "move" | "cancel" | "rebook" | "book" | "queue" | "not_now" | "stop";

const handle = async (
  conv: ConversationDocument,
  action: Action,
  args: string[],
  l: "bn" | "en",
): Promise<OutboundMessage[]> => {
  const [id, date, time] = args;
  switch (action) {
    case "stop": {
      if (conv.verifiedPhone)
        await setOptOut(conv.verifiedPhone, true, `Replied "Don't contact me" on ${conv.channel}`);
      return [text(await optOutReply(l))];
    }
    case "not_now":
      return [
        text(l === "bn" ? "ঠিক আছে। প্রয়োজন হলে এখানে লিখবেন। 🙏" : "No problem. Write here whenever you need us. 🙏"),
      ];
    case "confirm": {
      const a = await ownedAppointmentById(conv, id);
      if (a.status !== "booked")
        return [text(l === "bn" ? "এই অ্যাপয়েন্টমেন্টটি আর সক্রিয় নেই।" : "This appointment is no longer active.")];
      await AppointmentModel.updateOne({ _id: a._id }, { $set: { confirmedByPatient: true, confirmedAt: new Date() } });
      await recordAudit({
        action: "UPDATE",
        entityType: "Appointment",
        entityId: a._id,
        after: { confirmedByPatient: true },
        meta: { by: `patient reply (${conv.channel})` },
      });
      return [
        text(
          l === "bn"
            ? `ধন্যবাদ! ${formatDateFor(a.date, "bn")} ${formatTimeFor(a.slotTime, "bn")}-এ আপনার অপেক্ষায় থাকব। ১৫ মিনিট আগে আসবেন।`
            : `Thank you! We expect you on ${formatDateFor(a.date, "en")} at ${formatTimeFor(a.slotTime, "en")}. Please arrive 15 minutes early.`,
        ),
      ];
    }
    case "reschedule": {
      const a = await ownedAppointmentById(conv, id);
      if (!["booked", "checked_in"].includes(a.status))
        return [
          text(l === "bn" ? "এই অ্যাপয়েন্টমেন্টটি আর বদলানো যাবে না।" : "This appointment can no longer be changed."),
        ];
      const today = dhakaDate(new Date());
      const offer = await slotOffer(String(a.doctor._id), today, a.doctorAbsent ? a.date : undefined);
      if (!offer)
        return [
          text(
            l === "bn"
              ? "সামনের এক সপ্তাহে ফাঁকা সময় নেই। রিসেপশনে ফোন করুন।"
              : "No free times in the next week. Please call reception.",
          ),
        ];
      // The slot list of the chatbot, but each time moves THIS appointment (through the reschedule tool)
      const items: ReplyOption[] = offer.list.items.map((it) => {
        const t = it.id.split("|")[3];
        return { ...it, id: `auto|move|${a._id}|${offer.date}|${t}` };
      });
      return [
        { ...offer.list, items, text: `${offer.list.text}\n${l === "bn" ? "নতুন সময় বাছুন" : "Pick the new time"}` },
      ];
    }
    case "move": {
      await ownedAppointmentById(conv, id);
      const out = await rescheduleAppointmentTool.run(
        { appointmentRef: refFor(conv, "A", id), newDate: date, newSlotTime: time },
        toolCtx(conv),
      );
      return out.ui ?? [];
    }
    case "cancel": {
      await ownedAppointmentById(conv, id);
      const out = await cancelAppointmentTool.run({ appointmentRef: refFor(conv, "A", id) }, toolCtx(conv));
      return out.ui ?? [];
    }
    case "queue": {
      await ownedAppointmentById(conv, id);
      const out = await getQueueStatus.run({ appointmentRef: refFor(conv, "A", id) }, toolCtx(conv));
      if (out.ui?.length) return out.ui;
      return [text(l === "bn" ? "আজ আপনার কোনো সক্রিয় সিরিয়াল পাওয়া যায়নি।" : "No active serial for you today.")];
    }
    case "rebook":
    case "book": {
      const doctorId = await doctorForRef(conv, id);
      if (!doctorId)
        return [
          {
            type: "quick_replies",
            text: l === "bn" ? "কোন ডাক্তারের সিরিয়াল নিতে চান?" : "Which doctor would you like to see?",
            options: [{ id: "menu|book", label: l === "bn" ? "সিরিয়াল নিন" : "Book appointment" }],
          },
        ];
      const offer = await slotOffer(doctorId, dhakaDate(new Date()));
      if (!offer)
        return [
          text(
            l === "bn"
              ? "সামনের এক সপ্তাহে ফাঁকা সময় নেই। রিসেপশনে ফোন করুন।"
              : "No free times in the next week. Please call reception.",
          ),
        ];
      return [offer.list]; // tapping a time continues in the normal booking flow (patient choice + Confirm)
    }
  }
};

registerInteraction(async (conv, replyId, typed) => {
  // STOP / START work any time, typed in any case
  if (!replyId && typed && STOP.test(typed)) {
    if (conv.verifiedPhone) await setOptOut(conv.verifiedPhone, true, `Replied STOP on ${conv.channel}`);
    return { messages: [text(await optOutReply(lang(conv)))] };
  }
  if (!replyId && typed && START.test(typed)) {
    if (conv.verifiedPhone) await setOptOut(conv.verifiedPhone, false, `Replied START on ${conv.channel}`);
    return {
      messages: [
        text(
          lang(conv) === "bn"
            ? "আবার চালু হয়েছে — রিমাইন্ডার ও জরুরি তথ্য পাবেন। ধন্যবাদ!"
            : "You're back on — you'll get reminders and updates again. Thank you!",
        ),
      ],
    };
  }

  let id = replyId;
  if (!id && typed && conv.verifiedPhone) {
    const row = await recentAutomated(conv.verifiedPhone);
    id = typedButton(row, typed)?.id ?? "";
  }
  const [kind, action, ...args] = id.split("|");
  if (kind !== "auto" || !action) return null;
  const answered = await markReplied(conv.verifiedPhone, id, action);
  // Answer in the language of the message the patient is replying to
  const l = answered?.language === "en" || (!answered && lang(conv) === "en") ? "en" : "bn";
  try {
    return { messages: await handle(conv, action as Action, args, l) };
  } catch (err) {
    return { messages: friendly(err) };
  }
});
