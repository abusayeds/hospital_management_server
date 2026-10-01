/* eslint-disable @typescript-eslint/no-explicit-any */
import { InvoiceModel } from "../../modules/billing/invoice.model";
import { invoiceForLabOrder, invoiceForVisit } from "../../modules/billing/invoice.service";
import { LabOrderModel } from "../../modules/clinical/lab/labOrder.model";
import { VisitModel } from "../../modules/clinical/visits/visit.model";
import { generateDailyReport } from "../../modules/reports/dailyReport.service";
import { OperationalReportModel } from "../../modules/reports/operationalReport.model";
import { addDays, todayInDhaka } from "../../utils/date";
import { logger } from "../../utils/logger";

/**
 * Phase 7 backfill (idempotent). Billing started after visits and lab reports already existed, so the
 * invoices those events would have created are made now — from REAL records only (no fictional patients,
 * no invented payments: money is recorded when the counter actually collects it).
 */
export const backfillInvoices = async () => {
  const billed = new Set(
    (
      await InvoiceModel.find({ originKey: { $ne: null } })
        .select("originKey")
        .lean()
    ).map((i: any) => i.originKey),
  );
  let visits = 0;
  let labs = 0;

  const closed = await VisitModel.find({ status: "closed" })
    .select("_id appointment patient doctor date")
    .lean<any[]>();
  for (const v of closed) {
    if (billed.has(`visit:${v._id}`)) continue;
    try {
      if (
        await invoiceForVisit({
          visitId: String(v._id),
          appointmentId: String(v.appointment),
          patientId: String(v.patient),
          doctorId: String(v.doctor),
          date: v.date,
        })
      )
        visits += 1;
    } catch (err) {
      logger.warn({ err: (err as Error).message, visitId: String(v._id) }, "Backfill: visit skipped");
    }
  }

  const verified = await LabOrderModel.find({ status: { $in: ["ready", "delivered"] } })
    .select("_id")
    .lean<any[]>();
  for (const o of verified) {
    if (billed.has(`lab_order:${o._id}`)) continue;
    try {
      if (await invoiceForLabOrder({ labOrderId: String(o._id) })) labs += 1;
    } catch (err) {
      logger.warn({ err: (err as Error).message, labOrderId: String(o._id) }, "Backfill: lab order skipped");
    }
  }
  logger.info({ visits, labs }, "Billing backfill: invoices created for existing visits and lab reports");
};

/** A first operations report (yesterday) so the Reports page is not empty — AI if configured, else the summary */
export const seedYesterdayReport = async () => {
  const date = addDays(todayInDhaka(), -1);
  if (await OperationalReportModel.exists({ date })) return;
  const report = await generateDailyReport(date);
  logger.info({ date, source: report.source }, "Daily report created for yesterday");
};
