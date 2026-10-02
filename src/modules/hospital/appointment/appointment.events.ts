import { publish } from "../../../events/bus";
import { emitToPermission, emitToRoom } from "../../../sockets";
import { forgetDisplayBoard } from "../queue/display.service";
import type { AppointmentStatus } from "./appointment.model";
import type { AppointmentView } from "./appointment.service";

/**
 * Tell every open screen that an appointment changed, so reception, doctor and TV
 * screens refresh instantly without reloading. Payloads carry ids only; each screen
 * refetches what its user is allowed to see (the public board fetches masked data).
 *   appointment:updated → staff who can read appointments (lists, dashboards)
 *   queue:updated       → queue viewers, the doctor's own room and the TV display
 */
export const notifyAppointmentChanged = (a: Pick<AppointmentView, "id" | "date" | "status" | "doctor">) => {
  const signal = { id: a.id, doctorId: a.doctor.id, date: a.date, status: a.status };
  emitToPermission("appointment:read", "appointment:updated", signal);
  emitToPermission("queue:read", "queue:updated", { doctorId: a.doctor.id, date: a.date });
  emitToRoom(`doctor:${a.doctor.id}`, "queue:updated", { doctorId: a.doctor.id, date: a.date });
  forgetDisplayBoard();
  emitToRoom("display", "queue:updated", { doctorId: a.doctor.id });
};

/** Ask the TV to announce the current serial again (serial and room are not personal data) */
export const notifyRecall = (r: { doctorId: string; serialNo: number; roomNo?: string }) => {
  emitToRoom("display", "queue:recall", r);
  emitToRoom(`doctor:${r.doctorId}`, "queue:updated", { doctorId: r.doctorId });
};

// ------------------------------------------------------------------ domain events

// Which domain event a new status stands for (in_consultation is not a business event)
const STATUS_EVENT = {
  booked: "appointment.booked",
  cancelled: "appointment.cancelled",
  checked_in: "appointment.checked_in",
  no_show: "appointment.no_show",
  completed: "appointment.completed",
} as const;

type EventSource = Pick<AppointmentView, "id" | "date" | "slotTime" | "source" | "status"> & {
  patient: { id: string };
  doctor: { id: string };
};

/**
 * Publish the domain event for an appointment's new status (ids only). Call AFTER the
 * change committed. "Sent back to waiting" (in_consultation → checked_in) is not a new check-in.
 */
export const publishAppointmentStatus = (
  a: EventSource,
  from?: AppointmentStatus,
  extra: { visitId?: string | null } = {},
) => {
  const status = a.status as AppointmentStatus;
  if (status === "checked_in" && from === "in_consultation") return;
  const name = STATUS_EVENT[status as keyof typeof STATUS_EVENT];
  if (!name) return;
  const base = { appointmentId: a.id, patientId: a.patient.id, doctorId: a.doctor.id, date: a.date };
  if (name === "appointment.booked") void publish(name, { ...base, slotTime: a.slotTime, source: a.source });
  else if (name === "appointment.completed") void publish(name, { ...base, visitId: extra.visitId ?? null });
  else void publish(name, base);
};
