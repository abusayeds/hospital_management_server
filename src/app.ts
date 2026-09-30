import cookieParser from "cookie-parser";
import cors from "cors";
import express, { Application, Request, Response } from "express";
import helmet from "helmet";
import { env } from "./config/env";
import globalErrorHandler from "./middlewares/globalErrorHandler";
import notFound from "./middlewares/notFound";
import { generalLimiter } from "./middlewares/rateLimiter";
import { sanitizeRequest } from "./middlewares/sanitize";
import { verifyOrigin } from "./middlewares/verifyOrigin";
import router from "./routes";
import { httpLogger } from "./utils/logger";

const app: Application = express();

// Requests reach us through a proxy (the Next.js server in dev, Nginx in production).
// The real client IP is in X-Forwarded-For; rate limiting and audit logs need it.
// TRUST_PROXY decides which proxies are believed (default: only this machine).
app.set("trust proxy", parseTrustProxy(env.TRUST_PROXY));

// 1. Log every request, including ones rejected by later middleware
app.use(httpLogger);

// 2. Secure HTTP headers (CSP, no-sniff, frameguard, hides X-Powered-By, ...)
app.use(helmet());

// 3. Only our frontend may call the API from a browser, with cookies
app.use(
  cors({
    origin: env.CLIENT_URL,
    credentials: true,
  }),
);

// 4. Parse bodies, with a size cap so huge payloads cannot exhaust memory
app.use(express.json({ limit: env.JSON_BODY_LIMIT }));
app.use(express.urlencoded({ extended: false, limit: env.JSON_BODY_LIMIT }));
app.use(cookieParser());

// 5. Strip MongoDB operators ($gt, $where, ...) from user input
app.use(sanitizeRequest);

// 6. CSRF: reject state-changing requests coming from other websites
app.use("/api", verifyOrigin);

// 7. Throttle abusive clients
app.use("/api", generalLimiter);

app.use("/public", express.static("public"));

// 8. Versioned API
app.use("/api/v1", router);

app.get("/", (_req: Request, res: Response) => {
  res.json({ name: "Testolife API", docs: "/api/v1/health" });
});

// 9. Unknown routes, then the single error handler (must be registered last)
app.use(notFound);
app.use(globalErrorHandler);

// "1" → trust one hop, "true"/"false" → booleans, anything else ("loopback", an IP list) as-is
function parseTrustProxy(value: string): boolean | number | string {
  if (value === "true") return true;
  if (value === "false") return false;
  return /^\d+$/.test(value) ? Number(value) : value;
}

export default app;
