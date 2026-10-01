/**
 * AUTOMATION MODULE (Phase 6) — entry point. Importing it registers every rule and subscribes the
 * rules to the domain event bus. The scheduler is started by server.ts only (never in tests).
 */
import { wireEvents } from "./engine";
import "./rules";

wireEvents();

export { startScheduler, stopScheduler } from "./scheduler";
export { ensureDefaultTemplates } from "./templates/template.service";
