/**
 * DOMAIN EVENT CATALOG — every business event the system publishes, in one place.
 *
 * Payloads carry IDS AND DATES ONLY (no names, phones or clinical text): consumers load
 * whatever they need and are allowed to see. Every event is also stored in the
 * DomainEvent collection, so Phase 6 automation (reminders, follow-ups, report-ready
 * messages) can process them reliably and the admin can see an event log.
 *
 * To add an event: add its name + payload type here, publish it from the SERVICE after
 * the database change has committed, and document it in backend/README.md (§ Event catalog).
 */

type Id = string;
type IsoDate = string; // YYYY-MM-DD (Asia/Dhaka)

export type DomainEventMap = {
  "appointment.booked": {
    appointmentId: Id;
    patientId: Id;
    doctorId: Id;
    date: IsoDate;
    slotTime: string;
    source: string;
  };
  "appointment.cancelled": { appointmentId: Id; patientId: Id; doctorId: Id; date: IsoDate };
  "appointment.rescheduled": {
    fromAppointmentId: Id;
    toAppointmentId: Id;
    patientId: Id;
    doctorId: Id;
    date: IsoDate;
    slotTime: string;
  };
  "appointment.checked_in": { appointmentId: Id; patientId: Id; doctorId: Id; date: IsoDate };
  "appointment.no_show": { appointmentId: Id; patientId: Id; doctorId: Id; date: IsoDate };
  "appointment.completed": { appointmentId: Id; patientId: Id; doctorId: Id; date: IsoDate; visitId?: Id | null };
  "visit.closed": {
    visitId: Id;
    appointmentId: Id;
    patientId: Id;
    doctorId: Id;
    date: IsoDate;
    followUpDate: IsoDate | null;
  };
  "lab.order_created": {
    labOrderId: Id;
    visitId: Id | null;
    patientId: Id;
    doctorId: Id | null;
    priority: "routine" | "urgent";
  };
  "lab.sample_collected": { labOrderId: Id; patientId: Id };
  "lab.report_ready": { labOrderId: Id; patientId: Id; doctorId: Id | null; visitId: Id | null };
  // Patient assistant (Phase 5)
  "chat.message_received": { conversationId: Id; channel: string };
  "chat.booking_created": { conversationId: Id; appointmentId: Id; patientId: Id; channel: string };
  "chat.handover_requested": { conversationId: Id; channel: string; reason: string; emergency: boolean };
};

export type DomainEventName = keyof DomainEventMap;

export const DOMAIN_EVENT_NAMES = [
  "appointment.booked",
  "appointment.cancelled",
  "appointment.rescheduled",
  "appointment.checked_in",
  "appointment.no_show",
  "appointment.completed",
  "visit.closed",
  "lab.order_created",
  "lab.sample_collected",
  "lab.report_ready",
  "chat.message_received",
  "chat.booking_created",
  "chat.handover_requested",
] as const satisfies readonly DomainEventName[];

export type DomainEvent<N extends DomainEventName = DomainEventName> = {
  id: string;
  name: N;
  payload: DomainEventMap[N];
  occurredAt: Date;
};
