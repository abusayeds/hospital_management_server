import express from "express";
import { ChatRoutes } from "../modules/ai/chat/chat.route";
import { AuditRoutes } from "../modules/audit/audit.route";
import { AuthRoutes } from "../modules/auth/auth.route";
import { managementRoutes } from "../modules/basic_modules/management/management.route";
import { labTestCatalog, medicineCatalog, serviceCatalog } from "../modules/hospital/catalog/catalog.routes";
import { PublicRoutes, SettingsRoutes } from "../modules/hospital/settings/settings.route";
import { AppointmentRoutes } from "../modules/hospital/appointment/appointment.route";
import { DashboardRoutes } from "../modules/hospital/dashboard/dashboard.route";
import { DepartmentRoutes } from "../modules/hospital/department/department.route";
import { DoctorRoutes } from "../modules/hospital/doctor/doctor.route";
import { DisplayRoutes, QueueRoutes } from "../modules/hospital/queue/queue.route";
import { PatientRoutes } from "../modules/patients/patient.route";
import { UserRoutes } from "../modules/users/user.route";
import { HealthRoutes } from "./health.route";

// Mounted at /api/v1 in app.ts. A future /api/v2 can live beside it.
const router = express.Router();

const moduleRoutes: { path: string; route: express.Router }[] = [
  { path: "/health", route: HealthRoutes },
  { path: "/auth", route: AuthRoutes },
  { path: "/users", route: UserRoutes },
  { path: "/audit-logs", route: AuditRoutes },
  { path: "/management", route: managementRoutes },
  { path: "/departments", route: DepartmentRoutes },
  { path: "/doctors", route: DoctorRoutes },
  { path: "/services", route: serviceCatalog.router },
  { path: "/lab-tests", route: labTestCatalog.router },
  { path: "/medicines", route: medicineCatalog.router },
  { path: "/settings", route: SettingsRoutes },
  { path: "/public", route: PublicRoutes },
  { path: "/patients", route: PatientRoutes },
  { path: "/appointments", route: AppointmentRoutes },
  { path: "/queue", route: QueueRoutes },
  { path: "/display", route: DisplayRoutes },
  { path: "/dashboard", route: DashboardRoutes },
  { path: "/chat", route: ChatRoutes },
];

moduleRoutes.forEach(({ path, route }) => router.use(path, route));

export default router;
