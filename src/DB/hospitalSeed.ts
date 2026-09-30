/* eslint-disable @typescript-eslint/no-explicit-any */
import { LabTestModel, MedicineModel, ServiceModel } from "../modules/hospital/catalog/catalog.models";
import { DepartmentModel } from "../modules/hospital/department/department.model";
import { DoctorModel } from "../modules/hospital/doctor/doctor.model";
import { getSettings } from "../modules/hospital/settings/settings.service";
import { UserModel } from "../modules/users/user.model";
import { logger } from "../utils/logger";
import { DEMO_DOCTOR_PROFILE, DEPARTMENTS, DOCTORS, LAB_TESTS, MEDICINES, SERVICES } from "./seed-data/masterData";

/**
 * Master data (departments, doctors, services, lab tests, medicines, settings).
 * Idempotent: each row is matched by its natural key and only inserted if missing
 * ($setOnInsert), so re-running never duplicates rows or overwrites admin edits.
 */
const upsertAll = async (model: any, rows: any[], keyOf: (row: any) => Record<string, unknown>) => {
  if (!rows.length) return 0;
  const result = await model.bulkWrite(
    rows.map((row) => ({ updateOne: { filter: keyOf(row), update: { $setOnInsert: row }, upsert: true } })),
    { ordered: false },
  );
  return result.upsertedCount as number;
};

export const seedHospitalData = async () => {
  await getSettings(); // creates the settings document from .env defaults on first run

  const newDepartments = await upsertAll(DepartmentModel, DEPARTMENTS, (d) => ({ name: d.name }));
  const departments = await DepartmentModel.find({}, { name: 1 });
  const idByName = new Map(departments.map((d: any) => [d.name, d._id]));

  const doctorRows = DOCTORS.map(({ dept, ...d }) => ({ ...d, department: idByName.get(dept) }));
  const newDoctors = await upsertAll(DoctorModel, doctorRows, (d) => ({ name: d.name }));
  const newServices = await upsertAll(ServiceModel, SERVICES, (s) => ({ name: s.name }));
  const newTests = await upsertAll(LabTestModel, LAB_TESTS, (t) => ({ code: t.code }));
  const newMedicines = await upsertAll(MedicineModel, MEDICINES, (m) => ({
    brandName: m.brandName,
    strength: m.strength,
    form: m.form,
  }));

  const total = newDepartments + newDoctors + newServices + newTests + newMedicines;
  if (total) {
    logger.info(
      `Master data: +${newDepartments} departments, +${newDoctors} doctors, +${newServices} services, +${newTests} lab tests, +${newMedicines} medicines`,
    );
  }
};

/** Link the demo doctor login to its doctor profile (both sides, like linkDoctorAccount) */
export const linkDemoDoctor = async () => {
  const [user, doctor] = await Promise.all([
    UserModel.findOne({ email: "doctor@testolife.test" }),
    DoctorModel.findOne({ name: DEMO_DOCTOR_PROFILE }),
  ]);
  if (!user || !doctor || (doctor.user && String(doctor.user) === String(user._id))) return;
  if (await DoctorModel.exists({ user: user._id })) return; // already linked elsewhere by an admin
  await DoctorModel.updateOne({ _id: doctor._id }, { $set: { user: user._id } });
  await UserModel.updateOne({ _id: user._id }, { $set: { doctorProfile: doctor._id } });
  logger.info(`Linked demo doctor account to Dr. ${doctor.name}`);
};
