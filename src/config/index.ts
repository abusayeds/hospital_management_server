// Named exports kept for existing modules; all values come from the validated env.
import { env } from "./env";

export { env, isProduction } from "./env";

export const PORT = env.PORT;
export const DATABASE_URL = env.DATABASE_URL;
export const DB_NAME = env.DB_NAME;
export const JWT_SECRET_KEY = env.JWT_SECRET_KEY;
export const Nodemailer_GMAIL = env.Nodemailer_GMAIL;
export const Nodemailer_GMAIL_PASSWORD = env.Nodemailer_GMAIL_PASSWORD;
export const UPLOAD_FOLDER = env.UPLOAD_FOLDER;
export const max_file_size = env.max_file_size;
export const STRIPE_SECRET_KEY = env.STRIPE_SECRET_KEY;
export const NODE_ENV = env.NODE_ENV;

export const GEMINI_API_KEY = env.GEMINI_API_KEY;
export const GEMINI_MODEL = env.GEMINI_MODEL;
export const GEMINI_FALLBACK_MODELS = env.GEMINI_FALLBACK_MODELS;

export const HOSPITAL_NAME = env.HOSPITAL_NAME;
export const HOSPITAL_ADDRESS = env.HOSPITAL_ADDRESS;
export const HOSPITAL_EMERGENCY_PHONE = env.HOSPITAL_EMERGENCY_PHONE;
export const HOSPITAL_OPD_HOURS = env.HOSPITAL_OPD_HOURS;
