import express from "express";
import { WebChatRoutes } from "../modules/assistant/web.route";
import { KnowledgeRoutes } from "../modules/knowledge/knowledge.route";
import { AssistantAdminRoutes } from "../modules/assistant/admin.route";
import { InboxRoutes } from "../modules/assistant/inbox.route";
import { WhatsAppWebhookRoutes } from "../modules/assistant/channels/whatsapp/webhook.route";
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
import { AnalyticsRoutes } from "../modules/analytics/analytics.route";
import { DailyReportRoutes } from "../modules/reports/report.route";
import { EventRoutes } from "../events/events.route";
import { VitalsRoutes } from "../modules/clinical/vitals/vitals.route";
import { VisitRoutes } from "../modules/clinical/visits/visit.route";
import { LabRoutes } from "../modules/clinical/lab/lab.route";
import { AiSummaryRoutes } from "../modules/clinical/ai-summary/aiSummary.route";
import { VerifyRoutes } from "../documents/verify.route";
import { HealthRoutes } from "./health.route";
import { FinanceReportRoutes, InvoiceRoutes } from "../modules/billing/invoice.route";
import { AutomationRoutes } from "../modules/automation/automation.route";
import "../modules/automation"; // registers automation rules on the event bus

// Mounted at /api/v1 in app.ts. A future /api/v2 can live beside it.
const router = express.Router();

const moduleRoutes: { path: string; route: express.Router }[] = [
  { path: "/health", route: HealthRoutes },
  { path: "/auth", route: AuthRoutes },
  { path: "/users", route: UserRoutes },
  { path: "/audit-logs", route: AuditRoutes },
  { path: "/events", route: EventRoutes },
  { path: "/management", route: managementRoutes },
  { path: "/departments", route: DepartmentRoutes },
  { path: "/doctors", route: DoctorRoutes },
  { path: "/services", route: serviceCatalog.router },
  { path: "/lab-tests", route: labTestCatalog.router },
  { path: "/medicines", route: medicineCatalog.router },
  { path: "/settings", route: SettingsRoutes },
  { path: "/public/verify", route: VerifyRoutes },
  { path: "/public", route: PublicRoutes },
  { path: "/patients", route: PatientRoutes },
  { path: "/patients", route: VitalsRoutes.patientRouter },
  { path: "/patients", route: VisitRoutes.patientRouter },
  { path: "/patients", route: LabRoutes.patientRouter },
  { path: "/patients", route: AiSummaryRoutes },
  { path: "/appointments", route: AppointmentRoutes },
  { path: "/appointments", route: VitalsRoutes.appointmentRouter },
  { path: "/appointments", route: VisitRoutes.appointmentRouter },
  { path: "/visits", route: VisitRoutes.visitRouter },
  { path: "/lab-orders", route: LabRoutes.router },
  { path: "/vitals", route: VitalsRoutes.vitalsRouter },
  { path: "/queue", route: QueueRoutes },
  { path: "/display", route: DisplayRoutes },
  { path: "/dashboard", route: DashboardRoutes },
  { path: "/invoices", route: InvoiceRoutes },
  { path: "/reports", route: FinanceReportRoutes },
  { path: "/reports", route: DailyReportRoutes },
  { path: "/analytics", route: AnalyticsRoutes },
  { path: "/automation", route: AutomationRoutes },
  { path: "/assistant/web", route: WebChatRoutes },
  { path: "/knowledge", route: KnowledgeRoutes },
  { path: "/assistant/admin", route: AssistantAdminRoutes },
  { path: "/assistant/inbox", route: InboxRoutes },
  { path: "/webhooks/whatsapp", route: WhatsAppWebhookRoutes },
];

moduleRoutes.forEach(({ path, route }) => router.use(path, route));

export default router;
