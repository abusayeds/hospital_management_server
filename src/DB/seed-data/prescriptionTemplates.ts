/* eslint-disable @typescript-eslint/no-explicit-any */
import { PrescriptionTemplateModel } from "../../modules/clinical/visits/visit.model";
import { MedicineModel } from "../../modules/hospital/catalog/catalog.models";
import { UserModel } from "../../modules/users/user.model";
import { buildInstructions, MealTiming } from "../../shared/clinical-rules";
import { logger } from "../../utils/logger";

/**
 * The demo doctor's prescription templates (no patient data): five common prescriptions the doctor
 * can apply with one click on the visit screen. Runs once (when the doctor has no templates yet).
 */

type Rx = [brand: string, dose: string, timing: MealTiming | null, days: number | "continue"];

const TEMPLATES: { diagnosis: string; rx: Rx[]; adviceBn: string }[] = [
  {
    diagnosis: "Viral fever",
    rx: [
      ["Napa", "1+1+1", "after_meal", 5],
      ["Fexo", "0+0+1", "bedtime", 5],
    ],
    adviceBn: "প্রচুর পানি ও তরল খাবার খাবেন। জ্বর ১০২° এর বেশি হলে দ্রুত যোগাযোগ করুন।",
  },
  {
    diagnosis: "Essential hypertension",
    rx: [
      ["Amdocal", "0+0+1", "after_meal", "continue"],
      ["Rosuva", "0+0+1", "after_meal", 30],
    ],
    adviceBn: "লবণ কম খাবেন। প্রতিদিন ৩০ মিনিট হাঁটবেন। নিয়মিত প্রেসার মাপবেন।",
  },
  {
    diagnosis: "Acid peptic disease",
    rx: [
      ["Sergel", "1+0+1", "before_meal", 14],
      ["Motigut", "1+1+1", "before_meal", 7],
    ],
    adviceBn: "সময়মতো খাবেন, ঝাল-তেল কম খাবেন। খালি পেটে থাকবেন না।",
  },
  {
    diagnosis: "Type 2 diabetes mellitus",
    rx: [
      ["Comet", "1+0+1", "after_meal", "continue"],
      ["Secrin", "1+0+0", "before_meal", "continue"],
    ],
    adviceBn: "মিষ্টি ও ভাত কম খাবেন। নিয়মিত সুগার মাপবেন। পায়ের যত্ন নেবেন।",
  },
  {
    diagnosis: "Acute bronchitis",
    rx: [
      ["Azithrocin", "1+0+0", "before_meal", 5],
      ["Monas", "0+0+1", "bedtime", 14],
      ["Adovas", "2+2+2", "after_meal", 7],
    ],
    adviceBn: "গরম পানি পান করবেন, ধুলাবালি এড়িয়ে চলবেন।",
  },
];

export const seedPrescriptionTemplates = async () => {
  const doctorUser = await UserModel.findOne({ email: "doctor@testolife.test" });
  if (!doctorUser) return;
  if (await PrescriptionTemplateModel.exists({ owner: doctorUser._id })) return;
  const medicines = new Map((await MedicineModel.find().lean<any[]>()).map((m) => [m.brandName, m]));
  const items = (rx: Rx[]) =>
    rx
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
      .filter(Boolean);
  await PrescriptionTemplateModel.insertMany(
    TEMPLATES.map((t) => ({
      owner: doctorUser._id,
      name: t.diagnosis,
      diagnosis: t.diagnosis,
      adviceBn: t.adviceBn,
      items: items(t.rx),
      createdBy: doctorUser._id,
    })),
  );
  logger.info(`Prescription templates: ${TEMPLATES.length} for the demo doctor`);
};
