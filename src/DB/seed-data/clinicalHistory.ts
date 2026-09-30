/* eslint-disable @typescript-eslint/no-explicit-any */
import { Types } from "mongoose";
import { nextCode } from "../../models/counter.model";
import { LabOrderModel } from "../../modules/clinical/lab/labOrder.model";
import { PrescriptionTemplateModel, VisitModel } from "../../modules/clinical/visits/visit.model";
import { VitalsModel } from "../../modules/clinical/vitals/vitals.model";
import { AppointmentModel } from "../../modules/hospital/appointment/appointment.model";
import { LabTestModel, MedicineModel } from "../../modules/hospital/catalog/catalog.models";
import { DoctorModel } from "../../modules/hospital/doctor/doctor.model";
import { PatientModel } from "../../modules/patients/patient.model";
import { UserModel } from "../../modules/users/user.model";
import {
  buildInstructions,
  computeBmi,
  flagLabValue,
  flagVitals,
  LabFlag,
  MealTiming,
  worstLevel,
} from "../../shared/clinical-rules";
import { addDays, todayInDhaka } from "../../utils/date";
import { logger } from "../../utils/logger";

/**
 * DEMO CLINICAL HISTORY — visits, vitals, prescriptions and lab orders for the demo data, so
 * the doctor's history panel, the AI summary and the lab board have something to show.
 * All content is invented. Runs once (only when there are no visits yet). Deterministic.
 */

let seed = 4242;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)];
const between = (min: number, max: number) => min + Math.floor(rnd() * (max - min + 1));

type Rx = [brand: string, dose: string, timing: MealTiming | null, days: number | "continue"];
type Scenario = {
  complaints: string[];
  exam: string;
  diagnosis: string;
  rx: Rx[];
  adviceBn: string;
  labs: string[];
  followUpDays?: number;
  vitals: () => Record<string, number>;
};

const normalVitals = () => ({
  bpSystolic: between(110, 132),
  bpDiastolic: between(70, 85),
  pulse: between(68, 92),
  temperatureF: 98.4,
  spo2: between(96, 99),
});

const SCENARIOS: Scenario[] = [
  {
    complaints: ["Fever for 3 days", "Body ache"],
    exam: "Throat mildly congested. Chest clear.",
    diagnosis: "Viral fever",
    rx: [
      ["Napa", "1+1+1", "after_meal", 5],
      ["Fexo", "0+0+1", "bedtime", 5],
    ],
    adviceBn: "প্রচুর পানি ও তরল খাবার খাবেন। জ্বর ১০২° এর বেশি হলে দ্রুত যোগাযোগ করুন।",
    labs: ["CBC"],
    vitals: () => ({ ...normalVitals(), temperatureF: 100.8, pulse: between(92, 104) }),
  },
  {
    complaints: ["Headache", "Dizziness"],
    exam: "No focal neurological deficit.",
    diagnosis: "Essential hypertension",
    rx: [
      ["Amdocal", "0+0+1", "after_meal", "continue"],
      ["Rosuva", "0+0+1", "after_meal", 30],
    ],
    adviceBn: "লবণ কম খাবেন। প্রতিদিন ৩০ মিনিট হাঁটবেন। নিয়মিত প্রেসার মাপবেন।",
    labs: ["LIPID", "RBS"],
    followUpDays: 30,
    vitals: () => ({ ...normalVitals(), bpSystolic: between(148, 165), bpDiastolic: between(92, 102) }),
  },
  {
    complaints: ["Burning epigastric pain", "Sour belching"],
    exam: "Mild epigastric tenderness.",
    diagnosis: "Acid peptic disease",
    rx: [
      ["Sergel", "1+0+1", "before_meal", 14],
      ["Motigut", "1+1+1", "before_meal", 7],
    ],
    adviceBn: "সময়মতো খাবেন, ঝাল-তেল কম খাবেন। খালি পেটে থাকবেন না।",
    labs: [],
    vitals: normalVitals,
  },
  {
    complaints: ["Frequent urination", "Increased thirst"],
    exam: "Well hydrated. Feet: sensation intact.",
    diagnosis: "Type 2 diabetes mellitus",
    rx: [
      ["Comet", "1+0+1", "after_meal", "continue"],
      ["Secrin", "1+0+0", "before_meal", "continue"],
    ],
    adviceBn: "মিষ্টি ও ভাত কম খাবেন। নিয়মিত সুগার মাপবেন। পায়ের যত্ন নেবেন।",
    labs: ["FBS", "HBA1C"],
    followUpDays: 30,
    vitals: () => ({ ...normalVitals(), weightKg: between(72, 86), heightCm: between(158, 170) }),
  },
  {
    complaints: ["Cough for 1 week", "Runny nose"],
    exam: "Few scattered wheeze.",
    diagnosis: "Acute bronchitis",
    rx: [
      ["Azithrocin", "1+0+0", "before_meal", 5],
      ["Monas", "0+0+1", "bedtime", 14],
      ["Adovas", "2+2+2", "after_meal", 7],
    ],
    adviceBn: "গরম পানি পান করবেন, ধুলাবালি এড়িয়ে চলবেন।",
    labs: ["CBC"],
    followUpDays: 7,
    vitals: () => ({ ...normalVitals(), spo2: between(94, 96) }),
  },
];

const labFlagOf = (flags: (LabFlag | null)[]) => {
  const rank: Record<LabFlag, number> = { normal: 0, low: 1, high: 1, abnormal: 1, critical: 2 };
  const present = flags.filter(Boolean) as LabFlag[];
  return present.length ? present.reduce((a, b) => (rank[b] > rank[a] ? b : a), "normal") : null;
};

/** A plausible value for a parameter: mostly normal, sometimes a bit high/low */
const valueFor = (p: any) => {
  if (p.normalText) return p.normalText.split("/")[0];
  const min = p.normalMin ?? 0;
  const max = p.normalMax ?? min * 2 + 10;
  const span = max - min;
  const v = rnd() < 0.3 ? max + span * (0.1 + rnd() * 0.4) : min + span * (0.2 + rnd() * 0.6);
  return String(Math.round(v * 10) / 10);
};

const buildTests = (tests: any[], withResults: boolean) =>
  tests.map((t) => ({
    labTest: t._id,
    name: t.name,
    code: t.code,
    sampleType: t.sampleType,
    price: t.price,
    comment: "",
    results: (t.parameters?.length ? t.parameters : [{ name: "Result" }]).map((p: any) => {
      const value = withResults ? valueFor(p) : "";
      return {
        name: p.name,
        unit: p.unit ?? "",
        normalMin: p.normalMin ?? null,
        normalMax: p.normalMax ?? null,
        normalText: p.normalText ?? "",
        value,
        flag: flagLabValue(value, p),
      };
    }),
  }));

export const seedClinicalHistory = async () => {
  if ((await VisitModel.estimatedDocumentCount()) > 0) return;
  const [doctorUser, lab1, lab2, nurse] = await Promise.all([
    UserModel.findOne({ email: "doctor@testolife.test" }),
    UserModel.findOne({ email: "lab@testolife.test" }),
    UserModel.findOne({ email: "lab2@testolife.test" }),
    UserModel.findOne({ email: "nurse@testolife.test" }),
  ]);
  const doctor = doctorUser ? await DoctorModel.findOne({ user: doctorUser._id }) : null;
  if (!doctorUser || !doctor || !lab1 || !lab2) {
    logger.warn("Clinical history skipped: demo doctor / lab accounts are missing (set DEMO_PASSWORD and seed)");
    return;
  }
  const medicines = new Map((await MedicineModel.find().lean<any[]>()).map((m) => [m.brandName, m]));
  const labTests = new Map((await LabTestModel.find().lean<any[]>()).map((t) => [t.code, t]));
  const today = todayInDhaka();

  // ---- closed visits for the demo doctor's completed appointments (last 30 days)
  const past = await AppointmentModel.find({ doctor: doctor._id, status: "completed", date: { $lt: today } })
    .sort({ date: 1 })
    .limit(60)
    .lean<any[]>();
  let visits = 0;
  let orders = 0;
  for (const appt of past) {
    const s = pick(SCENARIOS);
    const closedAt = appt.completedAt ?? new Date(`${appt.date}T11:00:00+06:00`);
    const v = s.vitals();
    const vitalsDoc: any = {
      appointment: appt._id,
      patient: appt.patient,
      doctor: doctor._id,
      date: appt.date,
      ...v,
      bmi: computeBmi(v.weightKg, v.heightCm),
      recordedBy: nurse?._id ?? doctorUser._id,
      recordedAt: appt.checkedInAt ?? closedAt,
    };
    const flags = flagVitals(vitalsDoc);
    vitalsDoc.flags = flags;
    vitalsDoc.flagLevel = worstLevel(flags);
    await VitalsModel.create(vitalsDoc);

    const prescription = s.rx
      .map(([brand, dose, timing, days]) => {
        const m = medicines.get(brand);
        if (!m) return null;
        const text = buildInstructions({ dosePattern: dose, timing, durationDays: days });
        return {
          medicine: m._id,
          brandName: m.brandName,
          genericName: m.genericName,
          strength: m.strength ?? "",
          form: m.form,
          dosePattern: dose,
          timing,
          durationDays: days === "continue" ? null : days,
          continued: days === "continue",
          route: "oral",
          instructionsEn: text.en,
          instructionsBn: text.bn,
        };
      })
      .filter(Boolean);
    const tests = s.labs.map((c) => labTests.get(c)).filter(Boolean);
    const visit = await VisitModel.create({
      appointment: appt._id,
      patient: appt.patient,
      doctor: doctor._id,
      date: appt.date,
      status: "closed",
      chiefComplaints: s.complaints,
      examination: s.exam,
      provisionalDiagnosis: s.diagnosis,
      investigations: tests.map((t: any) => ({ labTest: t._id, name: t.name })),
      prescription,
      adviceBn: s.adviceBn,
      followUp: s.followUpDays ? { date: addDays(appt.date, s.followUpDays), note: "" } : null,
      vitalsSnapshot: { ...vitalsDoc, appointment: String(appt._id), patient: String(appt.patient) },
      prescriptionNo: await nextCode("prescription", "RX"),
      openedAt: appt.consultationStartedAt ?? closedAt,
      closedAt,
      closedBy: doctorUser._id,
      createdBy: doctorUser._id,
    });
    visits += 1;

    if (tests.length) {
      const delivered = rnd() < 0.7;
      const verifiedAt = new Date(closedAt.getTime() + 5 * 3600_000);
      const lines = buildTests(tests, true);
      await LabOrderModel.create({
        orderNo: await nextCode("lab_order", "LAB"),
        patient: appt.patient,
        visit: visit._id,
        doctor: doctor._id,
        date: appt.date,
        status: delivered ? "delivered" : "ready",
        tests: lines,
        clinicalNote: s.diagnosis,
        orderedBy: doctorUser._id,
        sampleCollectedAt: new Date(closedAt.getTime() + 20 * 60_000),
        sampleCollectedBy: lab1._id,
        resultsEnteredBy: lab1._id,
        resultsEnteredAt: new Date(closedAt.getTime() + 4 * 3600_000),
        verifiedBy: lab2._id,
        verifiedAt,
        deliveredAt: delivered ? new Date(verifiedAt.getTime() + 3600_000) : null,
        worstFlag: labFlagOf(lines.flatMap((l: any) => l.results.map((r: any) => r.flag))),
        history: [
          { status: "ordered", at: closedAt, by: doctorUser._id },
          { status: "sample_collected", at: new Date(closedAt.getTime() + 20 * 60_000), by: lab1._id },
          { status: "ready", at: verifiedAt, by: lab2._id, note: "verified" },
          ...(delivered ? [{ status: "delivered", at: new Date(verifiedAt.getTime() + 3600_000) }] : []),
        ],
        createdBy: doctorUser._id,
      });
      orders += 1;
    }
  }

  // One correction after signing, to show addenda
  const corrected = await VisitModel.findOne({ doctor: doctor._id, provisionalDiagnosis: "Viral fever" });
  if (corrected) {
    corrected.addenda.push({
      text: "NS1 antigen reported positive after the visit: dengue fever. Patient informed by phone.",
      reason: "Lab result arrived after the visit was closed",
      by: doctorUser._id as Types.ObjectId,
      byName: doctorUser.name,
      at: new Date(corrected.closedAt!.getTime() + 24 * 3600_000),
    });
    await corrected.save();
  }

  // ---- today's lab board: one order in every working status (four-eyes demo included)
  const todays = await AppointmentModel.find({ date: today, status: { $in: ["checked_in", "completed"] } })
    .limit(5)
    .lean<any[]>();
  const steps = ["ordered", "sample_collected", "processing", "awaiting_verification", "ready"] as const;
  for (const [i, appt] of todays.entries()) {
    const status = steps[i];
    const tests = [labTests.get(pick(["CBC", "RBS", "LIPID", "HBA1C"]))].filter(Boolean);
    const withResults = ["processing", "awaiting_verification", "ready"].includes(status);
    const lines = buildTests(tests, withResults);
    const now = new Date();
    await LabOrderModel.create({
      orderNo: await nextCode("lab_order", "LAB"),
      patient: appt.patient,
      doctor: appt.doctor,
      date: today,
      priority: i === 1 ? "urgent" : "routine",
      status,
      tests: lines,
      orderedBy: doctorUser._id,
      sampleCollectedAt: status === "ordered" ? null : now,
      sampleCollectedBy: status === "ordered" ? null : lab1._id,
      resultsEnteredBy: withResults ? lab1._id : null,
      resultsEnteredAt: withResults ? now : null,
      verifiedBy: status === "ready" ? lab2._id : null,
      verifiedAt: status === "ready" ? now : null,
      worstFlag: withResults ? labFlagOf(lines.flatMap((l: any) => l.results.map((r: any) => r.flag))) : null,
      history: [{ status: "ordered", at: now, by: doctorUser._id }],
      createdBy: doctorUser._id,
    });
    orders += 1;
  }

  // ---- the demo doctor's prescription templates
  const tpl = (name: string, diagnosis: string, rx: Rx[], adviceBn: string) => ({
    owner: doctorUser._id,
    name,
    diagnosis,
    adviceBn,
    items: rx
      .map(([brand, dose, timing, days]) => {
        const m = medicines.get(brand);
        if (!m) return null;
        const text = buildInstructions({ dosePattern: dose, timing, durationDays: days });
        return {
          medicine: m._id,
          brandName: m.brandName,
          genericName: m.genericName,
          strength: m.strength ?? "",
          form: m.form,
          dosePattern: dose,
          timing,
          durationDays: days === "continue" ? null : days,
          continued: days === "continue",
          instructionsEn: text.en,
          instructionsBn: text.bn,
        };
      })
      .filter(Boolean),
    createdBy: doctorUser._id,
  });
  await PrescriptionTemplateModel.insertMany(SCENARIOS.map((s) => tpl(s.diagnosis, s.diagnosis, s.rx, s.adviceBn)));

  // Patients seen by the demo doctor get a recorded allergy now and then (allergy check demo)
  const seen = [...new Set(past.map((a) => String(a.patient)))].slice(0, 3);
  await PatientModel.updateMany(
    { _id: { $in: seen }, allergies: { $size: 0 } },
    { $set: { allergies: ["Penicillin"] } },
  );

  logger.info(`Clinical history: ${visits} visits, ${orders} lab orders, ${SCENARIOS.length} templates`);
};
