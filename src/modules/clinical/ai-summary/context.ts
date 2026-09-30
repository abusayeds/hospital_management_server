/* eslint-disable @typescript-eslint/no-explicit-any */
import { assertDeidentified, scrubText } from "../../../ai/deidentify";
import { formatRange } from "../../../shared/clinical-rules";
import { ageOn, daysBetween, todayInDhaka } from "../../../utils/date";
import { PatientModel } from "../../patients/patient.model";
import { LabOrderModel } from "../lab/labOrder.model";
import { VisitModel } from "../visits/visit.model";
import { VitalsModel } from "../vitals/vitals.model";

/**
 * The patient's history as DE-IDENTIFIED JSON for the AI: age, gender and clinical facts only.
 * No name, phone, NID, address or patient code; dates become "days ago"; staff free text is
 * scrubbed; doctors' names are left out. The final JSON is checked again before it is returned.
 */
export const buildSummaryContext = async (patientId: string) => {
  const patient = await PatientModel.findById(patientId).lean<any>();
  if (!patient) return null;
  const identifiers = [
    patient.name,
    patient.nameBn,
    patient.phone,
    patient.altPhone,
    patient.patientCode,
    patient.address,
    patient.emergencyContact?.name,
    patient.emergencyContact?.phone,
  ];
  const clean = (text?: string | null, max = 400) => (text ? scrubText(text, identifiers).slice(0, max) : undefined);
  const today = todayInDhaka();
  const ago = (date: string) => daysBetween(date, today);

  const [visits, vitals, labs] = await Promise.all([
    VisitModel.find({ patient: patientId, status: "closed" }).sort({ date: -1 }).limit(8).lean<any[]>(),
    VitalsModel.find({ patient: patientId }).sort({ recordedAt: -1 }).limit(8).lean<any[]>(),
    LabOrderModel.find({ patient: patientId, status: { $in: ["ready", "delivered"] } })
      .sort({ verifiedAt: -1 })
      .limit(10)
      .lean<any[]>(),
  ]);

  const context = {
    patient: {
      age: ageOn(patient.dateOfBirth),
      gender: patient.gender,
      allergies: (patient.allergies ?? []).map((a: string) => clean(a, 100)),
      chronicConditions: (patient.chronicConditions ?? []).map((c: string) => clean(c, 100)),
    },
    visits: visits.map((v) => ({
      daysAgo: ago(v.date),
      complaints: (v.chiefComplaints ?? []).map((c: string) => clean(c, 150)),
      history: clean(v.historyOfPresentIllness),
      examination: clean(v.examination),
      diagnosis: clean(v.finalDiagnosis || v.provisionalDiagnosis, 200),
      medicines: (v.prescription ?? []).map((i: any) => ({
        name: [i.brandName, i.strength, i.genericName && `(${i.genericName})`].filter(Boolean).join(" "),
        dose: i.dosePattern,
        duration: i.continued ? "continue" : i.durationDays ? `${i.durationDays} days` : undefined,
      })),
      followUpInDays: v.followUp?.date ? daysBetween(v.date, v.followUp.date) : undefined,
      corrections: (v.addenda ?? []).map((a: any) => clean(a.text, 300)),
    })),
    vitals: vitals.map((v) => ({
      daysAgo: ago(v.date),
      bp: v.bpSystolic ? `${v.bpSystolic}/${v.bpDiastolic}` : undefined,
      pulse: v.pulse ?? undefined,
      temperatureF: v.temperatureF ?? undefined,
      spo2: v.spo2 ?? undefined,
      weightKg: v.weightKg ?? undefined,
      bmi: v.bmi ?? undefined,
      bloodSugar: v.bloodSugar?.value ? `${v.bloodSugar.value} mmol/L ${v.bloodSugar.type ?? ""}`.trim() : undefined,
      flags: (v.flags ?? []).map((f: any) => f.label),
    })),
    labs: labs.map((o) => ({
      daysAgo: ago(o.date),
      tests: (o.tests ?? []).map((t: any) => ({
        test: t.name,
        results: (t.results ?? []).map((r: any) => ({
          name: r.name,
          value: clean(r.value, 60),
          unit: r.unit || undefined,
          range: r.normalText || formatRange(r) || undefined,
          flag: r.flag && r.flag !== "normal" ? r.flag : undefined,
        })),
        comment: clean(t.comment, 200),
      })),
    })),
  };

  const json = JSON.stringify(context);
  assertDeidentified(json, identifiers); // fail closed
  return { context, json, hasHistory: visits.length + vitals.length + labs.length > 0 };
};
