import { Request } from "express";
import QRCode from "qrcode";
import { embeddedFontCss, esc, renderPdf } from "../../../documents/pdf";
import { signDocumentCode, verifyUrl } from "../../../documents/signing";
import AppError from "../../../errors/AppError";
import { recordAudit } from "../../audit/audit.service";
import { getSettings, HospitalSettings } from "../../hospital/settings/settings.service";
import { assertEmrAccess } from "../emr-access";
import { loadVisitView, VisitView } from "./visit.service";

/**
 * PRINTED PRESCRIPTION (A4 PDF, Bangla + English).
 * Only closed (signed) visits print — the prescription number and QR prove the paper is
 * genuine. Every print is a VIEW audit entry.
 */

const dateText = (iso: string) =>
  new Date(`${iso}T00:00:00+06:00`).toLocaleDateString("en-GB", {
    timeZone: "Asia/Dhaka",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

const GENDER = { male: "Male", female: "Female", other: "Other" } as Record<string, string>;

const section = (title: string, body: string) => (body ? `<div class="sec"><h3>${esc(title)}</h3>${body}</div>` : "");

const list = (items: string[]) => (items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : "");

export const buildPrescriptionHtml = (v: VisitView, hospital: HospitalSettings, qrSvg: string, code: string) => {
  const vt = v.vitals as Record<string, unknown> | null;
  const vitalLines = vt
    ? [
        vt.bpSystolic ? `BP: ${vt.bpSystolic}/${vt.bpDiastolic} mmHg` : "",
        vt.pulse ? `Pulse: ${vt.pulse}/min` : "",
        vt.temperatureF ? `Temp: ${vt.temperatureF} °F` : "",
        vt.spo2 ? `SpO₂: ${vt.spo2}%` : "",
        vt.weightKg ? `Weight: ${vt.weightKg} kg` : "",
        (vt.bloodSugar as { value?: number } | null)?.value
          ? `Sugar: ${(vt.bloodSugar as { value: number }).value} mmol/L`
          : "",
      ].filter(Boolean)
    : [];
  const diagnosis = v.finalDiagnosis || v.provisionalDiagnosis;

  const rx = v.prescription
    .map(
      (item, i) => `
      <li class="rx-item">
        <div class="rx-name">${i + 1}. ${item.form ? `<span class="form">${esc(item.form)}.</span> ` : ""}${esc(item.brandName)} ${esc(item.strength)}
          ${item.genericName ? `<span class="generic">(${esc(item.genericName)})</span>` : ""}</div>
        <div class="rx-bn">${esc(item.instructionsBn)}</div>
        ${item.note ? `<div class="rx-note">${esc(item.note)}</div>` : ""}
      </li>`,
    )
    .join("");

  const followUp = v.followUp?.date
    ? `<div class="follow">পরবর্তী সাক্ষাৎ / Follow-up: <b>${esc(dateText(v.followUp.date))}</b> ${v.followUp.note ? `— ${esc(v.followUp.note)}` : ""}</div>`
    : "";

  const addenda = v.addenda.length
    ? section(
        "Addenda",
        v.addenda
          .map((a) => `<p class="addendum">${esc(a.text)}<br><small>${esc(a.reason)} — ${esc(a.byName)}</small></p>`)
          .join(""),
      )
    : "";

  return `<!doctype html><html lang="bn"><head><meta charset="utf-8"><style>
${embeddedFontCss()}
*{box-sizing:border-box}
body{font-family:"Hind Siliguri",sans-serif;color:#1f2937;font-size:11.5pt;margin:0;line-height:1.45}
.head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #0f766e;padding-bottom:8px}
.hospital h1{margin:0;font-size:18pt;color:#0f766e}
.hospital .bn{font-size:13pt;font-weight:600}
.hospital p{margin:0;font-size:9.5pt;color:#4b5563}
.doctor{text-align:right}
.doctor h2{margin:0;font-size:13pt}
.doctor p{margin:0;font-size:9.5pt;color:#4b5563}
.patient{display:flex;flex-wrap:wrap;gap:4px 18px;padding:6px 0;border-bottom:1px solid #d1d5db;font-size:10.5pt}
.patient b{font-weight:600}
.body{display:flex;gap:14px;min-height:170mm}
.left{width:34%;border-right:1px solid #d1d5db;padding:8px 10px 0 0}
.right{flex:1;padding-top:8px}
.sec{margin-bottom:10px}
h3{margin:0 0 3px;font-size:9.5pt;text-transform:uppercase;letter-spacing:.04em;color:#0f766e}
ul{margin:0;padding-left:16px}
.rx-symbol{font-size:22pt;font-weight:700;color:#0f766e;line-height:1}
ol.rx{list-style:none;padding:0;margin:4px 0 12px}
.rx-item{margin-bottom:8px;page-break-inside:avoid}
.rx-name{font-weight:600}
.form{text-transform:capitalize;font-weight:400}
.generic{font-weight:400;color:#6b7280;font-size:9.5pt}
.rx-bn{padding-left:16px}
.rx-note{padding-left:16px;font-size:9.5pt;color:#6b7280}
.advice p{margin:0 0 3px}
.follow{margin-top:8px;padding:6px 8px;background:#f0fdfa;border:1px solid #99f6e4;border-radius:6px}
.addendum{margin:0 0 4px;font-size:10pt}
.foot{display:flex;justify-content:space-between;align-items:flex-end;border-top:1px solid #d1d5db;margin-top:10px;padding-top:8px;font-size:9pt;color:#6b7280;page-break-inside:avoid}
.qr{display:flex;gap:8px;align-items:center}
.qr svg{width:64px;height:64px}
.sign{text-align:center;min-width:55mm}
.sign .line{border-top:1px solid #6b7280;margin-bottom:2px}
</style></head><body>
<div class="head">
  <div class="hospital">
    <h1>${esc(hospital.name)}</h1>
    <div class="bn">${esc(hospital.nameBn)}</div>
    <p>${esc(hospital.address)}</p>
    <p>${esc([...(hospital.phones ?? []), hospital.emergencyPhone ? `Emergency: ${hospital.emergencyPhone}` : ""].filter(Boolean).join(" · "))}</p>
  </div>
  <div class="doctor">
    <h2>${esc(v.doctor.displayName)}</h2>
    ${"nameBn" in v.doctor && v.doctor.nameBn ? `<p>${esc(v.doctor.nameBn)}</p>` : ""}
    ${"degrees" in v.doctor ? `<p>${esc(v.doctor.degrees)}</p><p>${esc(v.doctor.specialization)}</p>` : ""}
  </div>
</div>
<div class="patient">
  <span><b>Name:</b> ${esc("name" in v.patient ? v.patient.name : "")}</span>
  <span><b>Age:</b> ${esc("age" in v.patient ? `${v.patient.age} y` : "")}</span>
  <span><b>Sex:</b> ${esc("gender" in v.patient ? GENDER[v.patient.gender] : "")}</span>
  <span><b>ID:</b> ${esc("patientCode" in v.patient ? v.patient.patientCode : "")}</span>
  <span><b>Date:</b> ${esc(dateText(v.date))}</span>
  <span><b>Rx No:</b> ${esc(v.prescriptionNo)}</span>
</div>
<div class="body">
  <div class="left">
    ${section("Chief complaints", list(v.chiefComplaints))}
    ${section("On examination", list(vitalLines) + (v.examination ? `<p>${esc(v.examination)}</p>` : ""))}
    ${section("Diagnosis", diagnosis ? `<p><b>${esc(diagnosis)}</b></p>` : "")}
    ${section("Investigations", list(v.investigations.map((i) => i.name)))}
    ${"allergies" in v.patient && v.patient.allergies.length ? section("Allergies", `<p>${esc(v.patient.allergies.join(", "))}</p>`) : ""}
  </div>
  <div class="right">
    <div class="rx-symbol">℞</div>
    <ol class="rx">${rx || "<li>—</li>"}</ol>
    ${section("উপদেশ / Advice", v.adviceBn || v.adviceEn ? `<div class="advice">${v.adviceBn ? `<p>${esc(v.adviceBn)}</p>` : ""}${v.adviceEn ? `<p>${esc(v.adviceEn)}</p>` : ""}</div>` : "")}
    ${v.referral?.to ? section("Referral", `<p>${esc(v.referral.to)}${v.referral.reason ? ` — ${esc(v.referral.reason)}` : ""}</p>`) : ""}
    ${followUp}
    ${addenda}
  </div>
</div>
<div class="foot">
  <div class="qr">${qrSvg}<div>Scan to verify this prescription<br><b>${esc(v.prescriptionNo)}</b><br>Code: ${esc(code.split(".")[1])}</div></div>
  <div>Generated by Testolife</div>
  <div class="sign"><div class="line"></div>${esc(v.doctor.displayName)}</div>
</div>
</body></html>`;
};

export const prescriptionPdf = async (req: Request, visitId: string) => {
  const visit = await loadVisitView(visitId);
  await assertEmrAccess(req, visit.patient.id);
  if (visit.status !== "closed" || !visit.prescriptionNo)
    throw new AppError(409, "Close (sign) the visit before printing the prescription.", "CONFLICT");

  const code = signDocumentCode(visit.prescriptionNo);
  const qrSvg = await QRCode.toString(verifyUrl(code), { type: "svg", margin: 0, errorCorrectionLevel: "M" });
  const pdf = await renderPdf(buildPrescriptionHtml(visit, await getSettings(), qrSvg, code));
  await recordAudit({
    req,
    action: "VIEW",
    entityType: "Visit",
    entityId: visit.id,
    meta: { output: "prescription_pdf", prescriptionNo: visit.prescriptionNo },
  });
  return { pdf, fileName: `${visit.prescriptionNo}.pdf` };
};
