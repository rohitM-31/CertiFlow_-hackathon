import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

function rate(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!(n >= 0 && n <= 1)) throw new Error(`${name} must be between 0 and 1`);
  return n;
}

const port = int("PORT", 4000);

export const config = {
  port,
  databaseUrl: required("DATABASE_URL"),
  jwtSecret: required("JWT_SECRET"),
  frontendUrl: process.env["FRONTEND_URL"] ?? "http://localhost:5173",
  publicBaseUrl: process.env["PUBLIC_BASE_URL"] ?? "http://localhost:5173",
  storageDir: process.env["STORAGE_DIR"] ?? "./storage",

  // Business rules (documented in the README requirements note).
  districtApprovalsRequired: int("DISTRICT_APPROVALS_REQUIRED", 2),
  largeBatchThreshold: int("LARGE_BATCH_THRESHOLD", 50), // more than this => quality review
  maxCandidatesPerBatch: int("MAX_CANDIDATES_PER_BATCH", 500),
  slaMinutes: int("SLA_MINUTES", 60),
  verifyRateLimitPerMinute: int("VERIFY_RATE_LIMIT_PER_MINUTE", 60),

  // WhatsApp (a stand-in provider is served by the API itself at /mock-whatsapp).
  whatsappApiUrl: process.env["WHATSAPP_API_URL"] ?? `http://localhost:${port}/mock-whatsapp`,
  whatsappTimeoutMs: int("WHATSAPP_TIMEOUT_MS", 3_000),
  mockWhatsappFailureRate: rate("MOCK_WHATSAPP_FAILURE_RATE", 0.2),
  mockWhatsappTimeoutRate: rate("MOCK_WHATSAPP_TIMEOUT_RATE", 0.1),
} as const;
