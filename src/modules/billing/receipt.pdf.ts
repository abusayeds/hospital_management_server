/* eslint-disable @typescript-eslint/no-explicit-any */
import { Request } from "express";
import QRCode from "qrcode";
import { embeddedFontCss, esc, renderPdf } from "../../documents/pdf";
import { signDocumentCode, verifyUrl } from "../../documents/signing";
import { maskName, registerDocumentResolver } from "../../documents/verify.route";
import { formatTaka } from "../../utils/money";
import { recordAudit } from "../audit/audit.service";
import { getSettings, HospitalSettings } from "../hospital/settings/settings.service";
import { InvoiceModel } from "./invoice.model";
import { getInvoice, InvoiceView } from "./invoice.service";

/**
 * PRINTED RECEIPT / INVOICE (A4 PDF). Money only — no diagnosis, no lab values, no medicines'
 * clinical details beyond the billed line text. The QR proves the paper is genuine
 * (public /verify page shows number, date, total, masked name).
 */

const METHOD = { cash: "Cash", card: "Card", bkash: "bKash", nagad: "Nagad" } as Record<string, string>;
const STATUS = {
  draft: "DRAFT — not a valid receipt",
  issued: "UNPAID",
  partial: "PARTIALLY PAID",
  paid: "PAID",
  refunded: "REFUNDED",
  void: "VOID",
} as Record<string, string>;

const dateText = (d: string | Date) =>
  new Date(typeof d === "string" && d.length === 10 ? `${d}T00:00:00+06:00` : d).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Dhaka",
  });
const timeText = (d: Date | string) =>
  new Date(d).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Dhaka" });

export const buildReceiptHtml = (inv: InvoiceView, hospital: HospitalSettings, qrSvg: string, code: string) => {
  const rows = inv.items
    .map(
      (l, i) => `<tr><td>${i + 1}</td><td>${esc(l.description)}</td><td class="n">${l.quantity}</td>
        <td class="n">${esc(formatTaka(l.unitPrice))}</td><td class="n">${esc(formatTaka(l.lineTotal))}</td></tr>`,
    )
    .join("");
  const discounts = inv.discounts
    .map((d: { amount: number; reason: string }) => `<tr class="sub"><td colspan="4">Discount — ${esc(d.reason)}</td><td class="n">− ${esc(formatTaka(d.amount))}</td></tr>`)
    .join("");
  const payments = inv.payments.length
    ? `<h3>Payments received</h3><table class="pay"><tr><th>Date</th><th>Method</th><th>Reference</th><th class="n">Amount</th></tr>${inv.payments
        .map((p: { at: Date; method: string; reference?: string; amount: number }) => `<tr><td>${esc(timeText(p.at))}</td><td>${esc(METHOD[p.method])}</td><td>${esc(p.reference ?? "—")}</td><td class="n">${esc(formatTaka(p.amount))}</td></tr>`)
        .join("")}${inv.refunds
        .map((r: { at: Date; method: string; reason: string; amount: number }) => `<tr class="refund"><td>${esc(timeText(r.at))}</td><td>Refund (${esc(METHOD[r.method])})</td><td>${esc(r.reason)}</td><td class="n">− ${esc(formatTaka(r.amount))}</td></tr>`)
        .join("")}</table>`
    : "";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
${embeddedFontCss()}
*{box-sizing:border-box}
body{font-family:"Hind Siliguri",sans-serif;color:#1f2937;font-size:11pt;margin:0;line-height:1.45}
.head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #0f766e;padding-bottom:8px}
.hospital h1{margin:0;font-size:18pt;color:#0f766e}.hospital .bn{font-size:12.5pt;font-weight:600}
.hospital p{margin:0;font-size:9.5pt;color:#4b5563}
.doc{text-align:right}.doc h2{margin:0;font-size:16pt;letter-spacing:1px}.doc p{margin:0;font-size:10pt}
.stamp{display:inline-block;margin-top:4px;padding:2px 10px;border:2px solid #0f766e;color:#0f766e;font-weight:700;font-size:10pt;border-radius:4px}
.stamp.due{border-color:#b91c1c;color:#b91c1c}
.meta{display:flex;justify-content:space-between;margin:12px 0;font-size:10.5pt;background:#f8fafc;padding:8px 10px;border-radius:6px}
table{width:100%;border-collapse:collapse;margin-top:6px}
th{text-align:left;font-size:9.5pt;color:#475569;border-bottom:1.5px solid #cbd5e1;padding:5px 6px}
td{padding:5px 6px;border-bottom:1px solid #e2e8f0;vertical-align:top}
.n{text-align:right;white-space:nowrap}
tr.sub td{color:#0f766e;font-style:italic}
.totals{margin-left:auto;width:55%;margin-top:8px}.totals td{border:0;padding:3px 6px}
.totals .grand td{font-size:13pt;font-weight:700;border-top:2px solid #0f766e}
.totals .due td{font-weight:700;color:#b91c1c}
h3{font-size:10.5pt;margin:16px 0 0;color:#0f766e}
table.pay td,table.pay th{font-size:9.5pt}tr.refund td{color:#b91c1c}
.foot{display:flex;justify-content:space-between;align-items:flex-end;margin-top:22px;border-top:1px dashed #94a3b8;padding-top:10px}
.thanks{font-size:12pt;font-weight:600;color:#0f766e}.terms{font-size:9pt;color:#64748b;max-width:70%}
.qr{text-align:center;font-size:7.5pt;color:#64748b}.qr svg{width:80px;height:80px}
</style></head><body>
<div class="head">
  <div class="hospital"><h1>${esc(hospital.name)}</h1><div class="bn">${esc(hospital.nameBn)}</div>
    <p>${esc(hospital.address)}</p><p>${esc([...(hospital.phones ?? []), hospital.email].filter(Boolean).join(" · "))}</p></div>
  <div class="doc"><h2>${inv.status === "paid" ? "RECEIPT" : "INVOICE"}</h2><p><b>${esc(inv.invoiceNo)}</b></p>
    <p>${esc(dateText(inv.date))}</p><span class="stamp ${inv.amountDue > 0 ? "due" : ""}">${esc(inv.overdue ? "OVERDUE" : STATUS[inv.status])}</span></div>
</div>
<div class="meta">
  <div><b>${esc(inv.patient.name)}</b> · ${esc(inv.patient.patientCode)}<br>${esc(inv.doctor?.displayName ?? "")}${inv.department ? ` · ${esc(inv.department.name)}` : ""}</div>
  <div class="n">Due date: <b>${esc(dateText(inv.dueDate))}</b></div>
</div>
<table><tr><th>#</th><th>Description</th><th class="n">Qty</th><th class="n">Rate</th><th class="n">Amount</th></tr>${rows}${discounts}</table>
<table class="totals">
  <tr><td>Subtotal</td><td class="n">${esc(formatTaka(inv.subtotal))}</td></tr>
  ${inv.discountTotal ? `<tr><td>Discounts</td><td class="n">− ${esc(formatTaka(inv.discountTotal))}</td></tr>` : ""}
  <tr><td>Tax / VAT</td><td class="n">${esc(formatTaka(inv.taxTotal))}</td></tr>
  <tr class="grand"><td>Total</td><td class="n">${esc(formatTaka(inv.total))}</td></tr>
  <tr><td>Paid</td><td class="n">${esc(formatTaka(inv.amountPaid))}</td></tr>
  ${inv.amountDue > 0 ? `<tr class="due"><td>Amount due</td><td class="n">${esc(formatTaka(inv.amountDue))}</td></tr>` : ""}
</table>
${payments}
<div class="foot">
  <div><div class="thanks">Thank you · ধন্যবাদ</div>
    <div class="terms">Payment terms: please pay any amount due by ${esc(dateText(inv.dueDate))}. Payments are accepted in cash, card, bKash and Nagad at the hospital counter. Keep this receipt for refunds and insurance claims.</div></div>
  <div class="qr">${qrSvg}<br>${esc(code.split(".")[0])}</div>
</div>
<p style="text-align:center;font-size:8pt;color:#94a3b8;margin-top:14px">Generated by Testolife</p>
</body></html>`;
};

export const receiptPdf = async (req: Request, invoiceId: string) => {
  const inv = await getInvoice(invoiceId);
  const code = signDocumentCode(inv.invoiceNo);
  const qrSvg = await QRCode.toString(verifyUrl(code), { type: "svg", margin: 0, errorCorrectionLevel: "M" });
  const pdf = await renderPdf(buildReceiptHtml(inv, await getSettings(), qrSvg, code));
  await recordAudit({ req, action: "VIEW", entityType: "Invoice", entityId: inv.id, meta: { output: "receipt_pdf", invoiceNo: inv.invoiceNo } });
  return { pdf, fileName: `${inv.invoiceNo}.pdf` };
};

// Public QR check: number, date, issuer, masked name — and the total (it is printed anyway)
registerDocumentResolver("INV", async (invoiceNo) => {
  const inv = await InvoiceModel.findOne({ invoiceNo }).setOptions({ withDeleted: true }).populate("patient", "name dateOfBirth").lean<any>();
  if (!inv || inv.status === "void") return null;
  return {
    type: "receipt",
    number: inv.invoiceNo,
    date: inv.date,
    issuedBy: `Accounts — total ${formatTaka(inv.total)}, ${inv.amountDue > 0 ? `${formatTaka(inv.amountDue)} due` : "fully paid"}`,
    patient: maskName(inv.patient?.name ?? ""),
    patientAge: null,
    signedAt: inv.issuedAt ?? null,
    corrections: (inv.refunds ?? []).length,
  };
});
