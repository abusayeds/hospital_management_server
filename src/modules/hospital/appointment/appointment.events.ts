import { emitToPermission, emitToRoom } from "../../../sockets";
import type { AppointmentView } from "./appointment.service";

/**
 * Tell every open screen that an appointment changed, so reception, doctor and TV
 * screens refresh instantly without reloading. Payloads carry ids only; each screen
 * refetches what its user is allowed to see (the TV fetches masked data with its key).
 *   appointment:updated → staff who can read appointments (lists, dashboards)
 *   queue:updated       → queue viewers, the doctor's own room and the TV display
 */
export const notifyAppointmentChanged = (a: Pick<AppointmentView, "id" | "date" | "status" | "doctor">) => {
  const signal = { id: a.id, doctorId: a.doctor.id, date: a.date, status: a.status };
  emitToPermission("appointment:read", "appointment:updated", signal);
  emitToPermission("queue:read", "queue:updated", { doctorId: a.doctor.id, date: a.date });
  emitToRoom(`doctor:${a.doctor.id}`, "queue:updated", { doctorId: a.doctor.id, date: a.date });
  emitToRoom("display", "queue:updated", { doctorId: a.doctor.id });
};

/** Ask the TV to announce the current serial again (serial and room are not personal data) */
export const notifyRecall = (r: { doctorId: string; serialNo: number; roomNo?: string }) => {
  emitToRoom("display", "queue:recall", r);
  emitToRoom(`doctor:${r.doctorId}`, "queue:updated", { doctorId: r.doctorId });
};
