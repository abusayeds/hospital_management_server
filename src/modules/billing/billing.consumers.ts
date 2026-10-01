import { subscribe } from "../../events/bus";
import { logger } from "../../utils/logger";
import { invoiceForLabOrder, invoiceForVisit } from "./invoice.service";

/**
 * AUTOMATIC BILLING — listens to clinical events instead of changing the clinical code:
 *   visit.closed      → consultation invoice (the appointment's fee snapshot: new or follow-up)
 *   lab.report_ready  → lab invoice (the order's test price snapshots)
 * (Pharmacy dispense calls invoiceForDispense() directly when that module exists.)
 *
 * Idempotent: the invoice's unique originKey ("visit:<id>", "lab_order:<id>") means an event
 * delivered twice — or retried after a failure — never bills the same encounter twice.
 * A failing consumer is marked "failed" on the stored DomainEvent (admin Event Log) and the
 * visit/lab request that published the event is never affected.
 */

subscribe("visit.closed", "billing:consultation-invoice", async ({ payload }) => {
  const invoice = await invoiceForVisit(payload);
  if (invoice) logger.info({ invoiceNo: invoice.invoiceNo, visitId: payload.visitId }, "Consultation invoice ready");
});

subscribe("lab.report_ready", "billing:lab-invoice", async ({ payload }) => {
  const invoice = await invoiceForLabOrder(payload);
  if (invoice) logger.info({ invoiceNo: invoice.invoiceNo, labOrderId: payload.labOrderId }, "Lab invoice ready");
});

export const billingConsumersRegistered = true;
