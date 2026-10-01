/**
 * AUTOMATION MODULE (Phase 6) — entry point. Importing it registers every rule, subscribes the rules to
 * the domain event bus and routes patients' replies to automated messages. The scheduler is started by
 * server.ts only (never in tests).
 */
import { wireEvents } from "./engine";
import "./replies";
import "./rules";

wireEvents();

export { startScheduler, stopScheduler } from "./scheduler";
export { ensureDefaultTemplates } from "./templates/template.service";
