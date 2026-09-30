# Backend source layout

A request flows **route → validation → controller → service → model**.
Business rules live only in services; controllers only translate HTTP ↔ service calls.

| Folder | Responsibility |
| --- | --- |
| `config/` | Validated env (`env.ts`), MongoDB connection (`database.ts`), **permission map** (`permissions.ts`, single source of truth for RBAC). Nothing reads `process.env` directly. |
| `middlewares/` | Cross-cutting HTTP concerns: sanitize, verifyOrigin (CSRF), rate limits, validateRequest, **authenticate**, **requirePermission / assertCanAccess**, 404, global error handler. |
| `routes/` | `/api/v1` router that mounts every module; shared routes such as `/health`. |
| `controllers/`, `services/` | Shared (non-domain) endpoints, e.g. health. |
| `modules/auth`, `modules/users`, `modules/audit` | Login/refresh/logout (cookies, rotation), user management, append-only audit log + `recordAudit()`. |
| `modules/<domain>/<feature>/` | One folder per feature: `*.route.ts` (routes + controllers), `*.validation.ts`, `*.service.ts`, `*.model.ts`. |
| `models/` | Shared models (`counter.model.ts`) and `plugins/basePlugin.ts` (timestamps, audit fields, soft delete). |
| `validators/` | Zod pieces reused across modules: password policy, BD phone, ObjectId, pagination. |
| `errors/` | `AppError` + translators from Zod / Mongoose / Mongo errors to our error format. |
| `sockets/` | Socket.IO: staff identified by cookie and grouped by permission (`emitToPermission`); public screens only get data-free signals (`emitPublic`). |
| `jobs/` | node-cron automation (reminders, follow-ups) — later phases. |
| `ai/` | Shared AI infrastructure (LLM client, prompts, RAG) — later phases. The patient chat currently lives in `modules/ai/chat`. |
| `utils/` | Small helpers: logger, catchAsync, sendResponse, dates. |
| `DB/` | Idempotent seeders (demo data only). |
