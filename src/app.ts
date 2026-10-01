import cookieParser from "cookie-parser";
import cors from "cors";
import express, { Application, Request, Response } from "express";
import helmet from "helmet";
import { env, isProduction } from "./config/env";
import AppError from "./errors/AppError";
import globalErrorHandler from "./middlewares/globalErrorHandler";
import notFound from "./middlewares/notFound";
import { generalLimiter, ipGuard, userReadLimiter, userWriteLimiter } from "./middlewares/rateLimiter";
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

// 2. Production: HTTPS only. Behind a proxy, X-Forwarded-Proto tells us (trust proxy above).
//    Page loads are redirected; API calls over plain HTTP are refused (a redirect would leak the body).
if (isProduction)
  app.use((req, res, next) => {
    if (req.secure) return next();
    if (req.method === "GET" || req.method === "HEAD")
      return res.redirect(308, `https://${req.get("host")}${req.originalUrl}`);
    next(new AppError(403, "HTTPS is required.", "FORBIDDEN"));
  });

// 3. Secure HTTP headers. The API serves JSON and PDFs only, so the CSP is very strict.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        imgSrc: ["'self'", "data:"],
        styleSrc: ["'self'", "'unsafe-inline'"], // PDF viewer and /public files only
        fontSrc: ["'self'", "data:"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        objectSrc: ["'none'"],
        ...(isProduction ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    // HSTS only in production (it would pin localhost to HTTPS in development)
    strictTransportSecurity: isProduction
      ? { maxAge: 365 * 24 * 60 * 60, includeSubDomains: true, preload: true }
      : false,
    referrerPolicy: { policy: "no-referrer" },
    crossOriginResourcePolicy: { policy: "same-site" },
  }),
);

// 4. Only our frontend may call the API from a browser, with cookies. A preflight from another
//    origin gets a 403; its simple requests get no CORS headers and meet the CSRF check (step 7).
app.use((req, _res, next) => {
  const origin = req.get("origin");
  if (req.method === "OPTIONS" && origin && !env.CLIENT_URL.includes(origin))
    return next(new AppError(403, "This origin is not allowed to call the API.", "FORBIDDEN"));
  next();
});
app.use(
  cors({
    origin: env.CLIENT_URL,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "X-Requested-With"],
    maxAge: 600,
  }),
);

// 5. Parse bodies, with a size cap so huge payloads cannot exhaust memory.
// The WhatsApp webhook keeps the RAW body: its HMAC signature is computed over the exact bytes.
app.use("/api/v1/webhooks/whatsapp", express.raw({ type: "*/*", limit: "1mb" }));
app.use(express.json({ limit: env.JSON_BODY_LIMIT }));
app.use(express.urlencoded({ extended: false, limit: env.JSON_BODY_LIMIT }));
app.use(cookieParser());

// 6. Strip MongoDB operators ($gt, $where, ...) from user input
app.use(sanitizeRequest);

// 7. CSRF: reject state-changing requests coming from other websites
app.use("/api", verifyOrigin);

// 8. Throttle abusive clients: blocked IPs and the IP circuit breaker first, then per IP and per user
app.use("/api", ipGuard);
app.use("/api", generalLimiter);
app.use("/api", userWriteLimiter, userReadLimiter);

app.use("/public", express.static("public"));

// 9. Versioned API
app.use("/api/v1", router);

app.get("/", (_req: Request, res: Response) => {
  res.json({ name: "Testolife API", docs: "/api/v1/health" });
});

// 10. Unknown routes, then the single error handler (must be registered last)
app.use(notFound);
app.use(globalErrorHandler);

// "1" → trust one hop, "true"/"false" → booleans, anything else ("loopback", an IP list) as-is
function parseTrustProxy(value: string): boolean | number | string {
  if (value === "true") return true;
  if (value === "false") return false;
  return /^\d+$/.test(value) ? Number(value) : value;
}

export default app;
