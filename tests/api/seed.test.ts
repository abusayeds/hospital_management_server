import { seedDemoUsers } from "../../src/DB/demoUsers";
import { linkDemoDoctor, seedHospitalData } from "../../src/DB/hospitalSeed";
import { seedPrescriptionTemplates } from "../../src/DB/seed-data/prescriptionTemplates";
import { PrescriptionTemplateModel } from "../../src/modules/clinical/visits/visit.model";
import { AppointmentModel } from "../../src/modules/hospital/appointment/appointment.model";
import { DoctorModel } from "../../src/modules/hospital/doctor/doctor.model";
import { PatientModel } from "../../src/modules/patients/patient.model";
import { UserModel } from "../../src/modules/users/user.model";
import { useTestDatabase } from "../helpers";

describe("Demo seed", () => {
  useTestDatabase();

  it("creates staff accounts, doctors and templates — but never fictional patients — and is idempotent", async () => {
    await seedHospitalData();
    await seedDemoUsers("Demo12345");
    await linkDemoDoctor();
    await seedPrescriptionTemplates();

    expect(await UserModel.countDocuments({ email: "admin@testolife.test" })).toBe(1);
    expect(await DoctorModel.countDocuments()).toBeGreaterThan(0);
    const templates = await PrescriptionTemplateModel.countDocuments();
    expect(templates).toBe(5);
    // Patients come only from reception (real phone numbers), so no message can reach a made-up number
    expect(await PatientModel.countDocuments()).toBe(0);
    expect(await AppointmentModel.countDocuments()).toBe(0);

    await seedPrescriptionTemplates();
    expect(await PrescriptionTemplateModel.countDocuments()).toBe(templates);
  }, 120_000);
});
