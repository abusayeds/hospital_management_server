import { AppointmentModel } from "../src/modules/hospital/appointment/appointment.model";
import { DepartmentModel } from "../src/modules/hospital/department/department.model";
import { DoctorModel } from "../src/modules/hospital/doctor/doctor.model";
import { clearSettingsCache } from "../src/modules/hospital/settings/settings.service";
import { PatientModel } from "../src/modules/patients/patient.model";
import { addDays, todayInDhaka } from "../src/utils/date";

export const TOMORROW = () => addDays(todayInDhaka(), 1);

/** A department and a doctor who sits every day 09:00–12:00 (10-minute slots) */
export const createClinic = async (overrides: { maxPatients?: number; followUpValidDays?: number; userId?: unknown; departmentName?: string; doctorName?: string } = {}) => {
  clearSettingsCache();
  // The unique indexes must exist before parallel inserts, or the race is not protected
  await Promise.all([AppointmentModel.init(), DoctorModel.init(), PatientModel.init()]);
  const department = await DepartmentModel.create({ name: overrides.departmentName ?? "Medicine", nameBn: "মেডিসিন" });
  const doctor = await DoctorModel.create({
    name: overrides.doctorName ?? "Test Doctor",
    department: department._id,
    consultationFee: 70000,
    followUpFee: 35000,
    followUpValidDays: overrides.followUpValidDays ?? 30,
    averageMinutesPerPatient: 10,
    roomNo: "101",
    user: overrides.userId ?? null,
    sessions: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, startTime: "09:00", endTime: "12:00", slotMinutes: 10, maxPatients: overrides.maxPatients ?? 18 })),
  });
  return { department, doctor };
};

let n = 0;
export const createPatients = async (count: number) =>
  Promise.all(
    Array.from({ length: count }, () => {
      n += 1;
      return PatientModel.create({
        patientCode: `TL-9${String(n).padStart(5, "0")}`,
        name: `Patient ${n}`,
        nameKey: `patient ${n}`,
        gender: "female",
        dateOfBirth: new Date("1990-01-01"),
        phone: `+88017${String(10000000 + n).slice(-8)}`,
      });
    }),
  );
