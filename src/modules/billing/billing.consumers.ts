import { subscribe } from "../../events/bus";
import { logger } from "../../utils/logger";
import { DispenseModel } from "../pharmacy/pharmacy.models";
import { invoiceForDispense, invoiceForLabOrder, invoiceForVisit } from "./invoice.service";

/**
 * AUTOMATIC BILLING — listens to clinical events instead of changing the clinical code:
 *   visit.closed      → consultation invoice (the appointment's fee snapshot: new or follow-up)
 *   lab.report_ready  → lab invoice (the order's test price snapshots)
 *   medicine.dispensed → pharmacy invoice (one line per medicine and batch price)
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

subscribe("medicine.dispensed", "billing:pharmacy-invoice", async ({ payload }) => {
  const d = await DispenseModel.findById(payload.dispenseId).lean<any>();
  if (!d) throw new Error(`Dispense ${payload.dispenseId} not found`);
  // Batches of one medicine can carry different prices: one invoice line per price
  const lines = d.items.flatMap((item: any) => {
    const byPrice = new Map<number, number>();
    for (const b of item.batches)
      byPrice.set(b.unitPrice ?? item.unitPrice, (byPrice.get(b.unitPrice ?? item.unitPrice) ?? 0) + b.quantity);
    return [...byPrice.entries()].map(([unitPrice, quantity]) => ({
      medicineId: String(item.medicine),
      description: item.description,
      quantity,
      unitPrice,
    }));
  });
  const invoice = await invoiceForDispense({ dispenseId: String(d._id), patientId: String(d.patient), lines });
  if (invoice) logger.info({ invoiceNo: invoice.invoiceNo, dispenseNo: d.dispenseNo }, "Pharmacy invoice ready");
});

export const billingConsumersRegistered = true;
