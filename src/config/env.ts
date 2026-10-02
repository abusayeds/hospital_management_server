import dotenv from "dotenv";
import path from "path";
import { z } from "zod";

dotenv.config({ path: path.join(process.cwd(), ".env") });

const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined));

// Every variable the app reads is declared here. The server refuses to start
// if anything required is missing or malformed, instead of failing later at runtime.
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(5000),

  DATABASE_URL: z
    .string({ required_error: "is required" })
    .regex(/^mongodb(\+srv)?:\/\//, "must be a mongodb:// or mongodb+srv:// connection string"),
  DB_NAME: z.string().min(1).default("testolife"),
  // Optional, e.g. "8.8.8.8,1.1.1.1". Fixes "querySrv ECONNREFUSED" when the local
  // DNS resolver cannot answer the SRV lookup that mongodb+srv:// URLs need.
  DNS_SERVERS: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    ),

  JWT_SECRET_KEY: z.string({ required_error: "is required" }).min(32, "must be at least 32 characters"),

  // Comma separated list of allowed browser origins (CORS + Socket.IO)
  CLIENT_URL: z
    .string({ required_error: "is required" })
    .transform((v) =>
      v
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().url("must be a valid URL")).min(1)),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60 * 1000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  JSON_BODY_LIMIT: z.string().default("100kb"),

  // Auth (Phase 2)
  ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5), // login attempts / 15 min / IP + email
  REFRESH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5), // token refreshes / 15 min / session
  CHANGE_PASSWORD_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5), // per 15 min per user
  // Per signed-in user, per hour: state-changing requests (POST/PUT/PATCH/DELETE) and reads.
  // Reads are higher because dashboards poll (the live queue refreshes every 10 s).
  USER_WRITE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(100),
  USER_READ_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(3000),
  // Assistant: patient messages answered by the AI per conversation (one WhatsApp number / web session)
  // per hour. 0 = unlimited (the default); the per-IP web chat limiter still applies.
  CHAT_HOURLY_LIMIT: z.coerce.number().int().min(0).default(0),
  // IP circuit breaker: more requests than this in an hour from one IP blocks that IP for IP_BLOCK_MINUTES
  IP_BLOCK_THRESHOLD_PER_HOUR: z.coerce.number().int().positive().default(1000),
  // Failed sign-ins from one IP in an hour before it is blocked and admins are alerted
  FAILED_LOGIN_BLOCK_THRESHOLD: z.coerce.number().int().positive().default(100),
  IP_BLOCK_MINUTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .default(60),
  // Never blocked by the breaker (e.g. the hospital's own public IP). Loopback is always exempt.
  IP_ALLOWLIST: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  // A rotated refresh token re-used within this window is treated as a two-tab race, not theft
  REFRESH_REUSE_GRACE_SECONDS: z.coerce.number().int().min(0).max(60).default(10),
  // HTTPS. Production needs EITHER a certificate for this process (TLS_CERT_PATH + TLS_KEY_PATH)
  // OR TLS_TERMINATED_BY_PROXY=true when Nginx / a load balancer serves HTTPS in front of it.
  TLS_CERT_PATH: optionalString,
  TLS_KEY_PATH: optionalString,
  TLS_TERMINATED_BY_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Which proxies may set X-Forwarded-For (Next.js dev server on this machine by default)
  TRUST_PROXY: z.string().default("loopback"),
  // Password for the seeded demo accounts (npm run seed). Never used in production.
  DEMO_PASSWORD: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z
      .string()
      .regex(/^(?=.*[A-Za-z])(?=.*\d).{8,}$/, "must be at least 8 characters with letters and numbers")
      .optional(),
  ),

  // AES-256-GCM key for sensitive patient fields (NID): 64 hex characters = 32 bytes.
  // Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ENCRYPTION_KEY: z
    .string({ required_error: "is required" })
    .regex(/^[0-9a-fA-F]{64}$/, "must be 64 hex characters (32 random bytes)"),

  // Printed documents (Phase 4): the QR on a prescription / lab report carries a signed code.
  // Optional: when empty a key is derived from JWT_SECRET_KEY. Changing it invalidates old QR codes.
  DOCUMENT_SIGNING_KEY: optionalString,
  // Public site the QR links to (the verify page). Defaults to the first CLIENT_URL.
  PUBLIC_APP_URL: optionalString,
  // Chrome/Chromium used for PDFs. Empty = the browser downloaded by `npm run pdf:setup`.
  PDF_BROWSER_PATH: optionalString,

  // Clinical AI features (Phase 4). The provider is swappable; only "gemini" is built in.
  // "none" turns the features off (the screens then say the summary is not configured).
  AI_PROVIDER: z.enum(["gemini", "none"]).default("gemini"),
  AI_API_KEY: optionalString, // falls back to GEMINI_API_KEY
  AI_MODEL: optionalString, // falls back to GEMINI_MODEL; GEMINI_FALLBACK_MODELS are tried next
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(20000),
  AI_MAX_INPUT_CHARS: z.coerce.number().int().min(1000).max(100000).default(12000),
  // Knowledge base search (Phase 5). Atlas Vector Search index name; empty embeddings = text search only.
  AI_EMBEDDING_MODEL: z.string().default("gemini-embedding-001"),
  AI_EMBEDDING_DIMENSIONS: z.coerce.number().int().min(64).max(3072).default(768),
  KNOWLEDGE_VECTOR_INDEX: z.string().default("knowledge_vector_index"),

  // WhatsApp Cloud API (Phase 5). All empty = the WhatsApp channel is off.
  WHATSAPP_PHONE_NUMBER_ID: optionalString,
  WHATSAPP_ACCESS_TOKEN: optionalString,
  WHATSAPP_VERIFY_TOKEN: optionalString, // any secret string; the same value is typed in the Meta webhook settings
  WHATSAPP_APP_SECRET: optionalString, // Meta app secret: verifies X-Hub-Signature-256 on every webhook call
  WHATSAPP_API_VERSION: z.string().default("v21.0"),

  GEMINI_API_KEY: optionalString,
  GEMINI_MODEL: z.string().default("gemini-3.5-flash"),
  GEMINI_FALLBACK_MODELS: z
    .string()
    .default("gemini-3.1-flash-lite,gemini-flash-lite-latest,gemini-flash-latest")
    .transform((v) =>
      v
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean),
    ),

  HOSPITAL_NAME: z.string().default("Testolife Hospital"),
  HOSPITAL_ADDRESS: z.string().default("Arshinagar, Amtola, Near Bosila Bridge, Keraniganj, Dhaka"),
  HOSPITAL_EMERGENCY_PHONE: z.string().default("999"),
  HOSPITAL_OPD_HOURS: z.string().default("Saturday–Thursday, 9:00 AM – 9:00 PM"),

  Nodemailer_GMAIL: optionalString,
  Nodemailer_GMAIL_PASSWORD: optionalString,
  UPLOAD_FOLDER: z.string().default("public/uploads"),
  max_file_size: z.coerce.number().positive().default(5),
  STRIPE_SECRET_KEY: optionalString,
});

export type Env = z.infer<typeof envSchema>;

// Production refuses to start with development-grade settings
export const productionSchema = envSchema.superRefine((e, ctx) => {
  if (e.NODE_ENV !== "production") return;
  const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  if (!e.TLS_TERMINATED_BY_PROXY && !(e.TLS_CERT_PATH && e.TLS_KEY_PATH))
    issue(
      "TLS_CERT_PATH",
      "production needs TLS_CERT_PATH and TLS_KEY_PATH, or TLS_TERMINATED_BY_PROXY=true behind an HTTPS proxy",
    );
  if (e.AI_PROVIDER !== "none" && !(e.AI_API_KEY || e.GEMINI_API_KEY))
    issue("AI_API_KEY", "is required in production (or set AI_PROVIDER=none to switch AI features off on purpose)");
  for (const origin of e.CLIENT_URL)
    if (!origin.startsWith("https://")) issue("CLIENT_URL", `must use https:// in production (${origin})`);
  if (e.DEMO_PASSWORD) issue("DEMO_PASSWORD", "must not be set in production");
});

const loadEnv = (): Env => {
  const parsed = productionSchema.safeParse(process.env);
  if (parsed.success) return parsed.data;

  // Logger is not ready yet (it depends on env), so print directly.
  const lines = parsed.error.issues.map((i) => `  • ${i.path.join(".")}: ${i.message}`);
  console.error(
    ["", "❌ Invalid environment configuration. Fix backend/.env (see .env.example):", ...lines, ""].join("\n"),
  );
  process.exit(1);
};

export const env = loadEnv();
export const isProduction = env.NODE_ENV === "production";
