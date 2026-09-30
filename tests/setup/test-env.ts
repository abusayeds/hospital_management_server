// Runs before every test file, BEFORE any app module is imported, so the
// validated env picks up these safe test values instead of the real .env ones.
import { randomUUID } from "crypto";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.TEST_MONGO_URI ?? "mongodb://127.0.0.1:27017/";
process.env.DB_NAME = `testolife_test_${randomUUID().slice(0, 8)}`; // fresh database per test file
process.env.JWT_SECRET_KEY = "test-secret-test-secret-test-secret-1234";
process.env.CLIENT_URL = "http://localhost:3000";
process.env.BCRYPT_ROUNDS = "4"; // fast hashing in tests only
process.env.REFRESH_REUSE_GRACE_SECONDS = "0"; // any reuse counts as theft in tests
process.env.AUTH_RATE_LIMIT_MAX = "1000";
process.env.RATE_LIMIT_MAX = "10000";
process.env.DNS_SERVERS = "";
process.env.DEMO_PASSWORD = "";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.QUEUE_DISPLAY_KEY = "test-display-key-123";
// Never call a real AI provider from tests (tests install fake providers where they need one)
process.env.GEMINI_API_KEY = "";
process.env.AI_API_KEY = "";
// WhatsApp "configured" with test values; tests replace the Meta transport, so nothing leaves the machine
process.env.WHATSAPP_PHONE_NUMBER_ID = "100000000000001";
process.env.WHATSAPP_ACCESS_TOKEN = "test-access-token";
process.env.WHATSAPP_VERIFY_TOKEN = "test-verify-token";
process.env.WHATSAPP_APP_SECRET = "test-app-secret";
