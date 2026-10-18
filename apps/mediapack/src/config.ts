// Environment parsing. Everything is optional at parse time so /health and MCP introspection work with
// partial config; each integration calls require*() when it is actually used and gets a clear error.
import { createHmac, X509Certificate } from "node:crypto";
import { z } from "zod";
import { AppError } from "./services/errors.js";

const Str = z.string().trim().min(1).optional();

const Env = z.object({
  NODE_ENV: z.string().optional(),
  PORT: z.string().optional(),
  PUBLIC_BASE_URL: z.string().url().optional(), // preferred; PUBLIC_ORIGIN is an alias
  MCP_PUBLIC_URL: z.string().url().optional(), // separate Manufact /mcp endpoint
  PUBLIC_ORIGIN: z.string().url().default("http://localhost:3000"),
  ALLOWED_ORIGINS: z.string().optional(), // comma separated, in addition to PUBLIC_ORIGIN
  DATABASE_URL: Str,
  DATABASE_CA_CERT_BASE64: Str,
  CAPABILITY_PEPPER: Str,
  WORKER_TOKEN_SECRET: Str,
  INTERNAL_TICK_TOKEN: Str,
  SUPABASE_URL: Str,
  SUPABASE_SERVICE_ROLE_KEY: Str,
  STORAGE_BUCKET: z.string().default("mediapack-private"),
  PAYMENTS_MODE: z.enum(["test", "live"]).default("test"),
  STRIPE_SECRET_KEY: Str,
  STRIPE_PROFILE_ID: Str,
  STRIPE_TEST_NETWORK_ID: z.literal("internal").optional(),
  STRIPE_WEBHOOK_SECRET: Str,
  MPP_SECRET_KEY: Str,
  STRIPE_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  STRIPE_API_BASE: Str, // test harness only: http://127.0.0.1:PORT fake Stripe
  PRIMITIVE_API_KEY: Str,
  PRIMITIVE_WEBHOOK_SECRET: Str,
  PRIMITIVE_CONTROL_ADDRESS: Str,
  PRIMITIVE_WORKER_ADDRESS: Str,
  PRIMITIVE_REQUIRE_SENDER_AUTH: z.enum(["true", "false"]).default("false"),
  UNPAID_STORAGE_CAP_BYTES: z.coerce.number().int().positive().default(2 * 1024 ** 3),
  GLOBAL_CLIENTS_PER_HOUR: z.coerce.number().int().positive().default(300),
  SOURCE_CLIENTS_PER_HOUR: z.coerce.number().int().positive().default(20),
  DEMO_BUYER_ENABLED: z.enum(["true", "false"]).default("false"),
  DEMO_BUYER_PER_CLIENT_DAILY: z.coerce.number().int().positive().max(2).default(2),
  DEMO_BUYER_GLOBAL_DAILY: z.coerce.number().int().positive().max(100).default(100),
  WORKER_LEASE_SECONDS: z.coerce.number().int().positive().default(1200),
  WORKER_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(1800),
  APP_DIST_DIR: Str,
});

export interface Config {
  nodeEnv: string;
  isProd: boolean;
  publicOrigin: string;
  mcpPublicUrl?: string;
  allowedOrigins: string[];
  databaseUrl?: string;
  databaseCaCert?: string;
  pepper?: string;
  workerTokenSecret?: string;
  internalTickToken?: string;
  supabaseUrl?: string;
  supabaseServiceRoleKey?: string;
  bucket: string;
  paymentsMode: "test" | "live";
  stripeSecretKey?: string;
  stripeProfileId?: string;
  stripeTestNetworkId?: "internal";
  stripeWebhookSecret?: string;
  mppSecretKey?: string;
  stripeApiBase?: string;
  stripeTimeoutMs: number;
  primitiveApiKey?: string;
  primitiveWebhookSecret?: string;
  controlAddress?: string;
  workerAddress?: string;
  requireSenderAuth: boolean;
  unpaidStorageCapBytes: number;
  globalClientsPerHour: number;
  sourceClientsPerHour: number;
  /** In-browser demo agent. `enabled` already folds in every safety condition; check only it. */
  demoBuyer: { enabled: boolean; perClientDaily: number; globalDaily: number };
  workerLeaseSeconds: number;
  workerTokenTtlSeconds: number;
  appDistDir?: string;
}

export function parseConfig(raw: Record<string, string | undefined> = process.env): Config {
  const r = Env.safeParse(Object.fromEntries(Object.entries(raw).filter(([, value]) => value?.trim() !== "")));
  if (!r.success) {
    throw new AppError("INTERNAL", `Invalid environment: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const e = r.data;
  let databaseCaCert: string | undefined;
  if (e.DATABASE_CA_CERT_BASE64) {
    try {
      const decoded = Buffer.from(e.DATABASE_CA_CERT_BASE64, "base64");
      if (decoded.toString("base64") !== e.DATABASE_CA_CERT_BASE64) throw new Error("invalid encoding");
      databaseCaCert = decoded.toString("utf8");
      if (!databaseCaCert.includes("-----BEGIN CERTIFICATE-----")) throw new Error("not PEM");
      new X509Certificate(databaseCaCert);
    } catch {
      throw new AppError("INTERNAL", "DATABASE_CA_CERT_BASE64 must contain the base64-encoded PEM certificate for the trusted database CA.");
    }
  }
  const origin = (e.PUBLIC_BASE_URL ?? e.PUBLIC_ORIGIN).replace(/\/$/, "");
  const cfg: Config = {
    nodeEnv: e.NODE_ENV ?? "development",
    isProd: e.NODE_ENV === "production",
    publicOrigin: origin,
    mcpPublicUrl: e.MCP_PUBLIC_URL,
    allowedOrigins: [...new Set([origin, ...(e.ALLOWED_ORIGINS?.split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean) ?? [])])],
    databaseUrl: e.DATABASE_URL,
    databaseCaCert,
    pepper: e.CAPABILITY_PEPPER,
    workerTokenSecret: e.WORKER_TOKEN_SECRET,
    internalTickToken: e.INTERNAL_TICK_TOKEN,
    supabaseUrl: e.SUPABASE_URL,
    supabaseServiceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY,
    bucket: e.STORAGE_BUCKET,
    paymentsMode: e.PAYMENTS_MODE,
    stripeSecretKey: e.STRIPE_SECRET_KEY,
    stripeProfileId: e.STRIPE_PROFILE_ID,
    stripeTestNetworkId: e.STRIPE_TEST_NETWORK_ID,
    stripeWebhookSecret: e.STRIPE_WEBHOOK_SECRET,
    mppSecretKey: e.MPP_SECRET_KEY,
    stripeApiBase: e.STRIPE_API_BASE,
    stripeTimeoutMs: e.STRIPE_TIMEOUT_MS,
    primitiveApiKey: e.PRIMITIVE_API_KEY,
    primitiveWebhookSecret: e.PRIMITIVE_WEBHOOK_SECRET,
    controlAddress: e.PRIMITIVE_CONTROL_ADDRESS,
    workerAddress: e.PRIMITIVE_WORKER_ADDRESS,
    requireSenderAuth: e.PRIMITIVE_REQUIRE_SENDER_AUTH === "true",
    unpaidStorageCapBytes: e.UNPAID_STORAGE_CAP_BYTES,
    globalClientsPerHour: e.GLOBAL_CLIENTS_PER_HOUR,
    sourceClientsPerHour: e.SOURCE_CLIENTS_PER_HOUR,
    demoBuyer: {
      // Test mode only, and only when MPP challenges use the explicit `internal` sandbox network (a configured
      // STRIPE_PROFILE_ID takes precedence in requireStripe(), so it must be absent). Anything else stays off.
      enabled: e.DEMO_BUYER_ENABLED === "true" && e.PAYMENTS_MODE === "test" && /^(sk|rk)_test_/.test(e.STRIPE_SECRET_KEY ?? "") &&
        e.STRIPE_TEST_NETWORK_ID === "internal" && !e.STRIPE_PROFILE_ID,
      perClientDaily: e.DEMO_BUYER_PER_CLIENT_DAILY,
      globalDaily: e.DEMO_BUYER_GLOBAL_DAILY,
    },
    workerLeaseSeconds: e.WORKER_LEASE_SECONDS,
    workerTokenTtlSeconds: e.WORKER_TOKEN_TTL_SECONDS,
    appDistDir: e.APP_DIST_DIR,
  };
  assertPaymentsSafety(cfg);
  return cfg;
}

/** PAYMENTS_MODE=test refuses live keys / non-test profiles at startup. */
export function assertPaymentsSafety(cfg: Config): void {
  if (cfg.stripeTestNetworkId && cfg.paymentsMode !== "test") {
    throw new AppError("INTERNAL", "STRIPE_TEST_NETWORK_ID is permitted only with PAYMENTS_MODE=test.");
  }
  if (cfg.paymentsMode !== "test") return;
  if (cfg.stripeSecretKey && !/^(sk|rk)_test_/.test(cfg.stripeSecretKey)) {
    throw new AppError("INTERNAL", "PAYMENTS_MODE=test refuses to start: STRIPE_SECRET_KEY is not a test-mode key (sk_test_/rk_test_).");
  }
  if (cfg.stripeProfileId && !cfg.stripeProfileId.startsWith("profile_test_")) {
    throw new AppError("INTERNAL", "PAYMENTS_MODE=test refuses to start: STRIPE_PROFILE_ID is not a profile_test_ id.");
  }
}

function need<K extends keyof Config>(cfg: Config, key: K, envName: string, what: string): NonNullable<Config[K]> {
  const v = cfg[key];
  if (v === undefined || v === null || v === "") {
    throw new AppError("INTERNAL", `${what} is not configured: set ${envName}.`, { status: 503 });
  }
  return v as NonNullable<Config[K]>;
}

export const requireDatabaseUrl = (c: Config) => need(c, "databaseUrl", "DATABASE_URL", "Database");
export const requirePepper = (c: Config) => {
  const p = need(c, "pepper", "CAPABILITY_PEPPER", "Access control");
  if (p.length < 16) throw new AppError("INTERNAL", "CAPABILITY_PEPPER must be at least 16 characters.", { status: 503 });
  return p;
};
export const requireWorkerTokenSecret = (c: Config) => need(c, "workerTokenSecret", "WORKER_TOKEN_SECRET", "Worker tokens");
export const requireTickToken = (c: Config) => need(c, "internalTickToken", "INTERNAL_TICK_TOKEN", "Internal tick");
export const requireStripe = (c: Config) => ({
  secretKey: need(c, "stripeSecretKey", "STRIPE_SECRET_KEY", "Stripe"),
  networkId: c.stripeProfileId ?? (c.paymentsMode === "test" && c.stripeTestNetworkId === "internal"
    ? "internal" : need(c, "stripeProfileId", "STRIPE_PROFILE_ID", "Stripe")),
});
export const requireStripeWebhookSecret = (c: Config) => need(c, "stripeWebhookSecret", "STRIPE_WEBHOOK_SECRET", "Stripe webhooks");
export const requirePrimitive = (c: Config) => ({
  apiKey: need(c, "primitiveApiKey", "PRIMITIVE_API_KEY", "Primitive"),
  control: need(c, "controlAddress", "PRIMITIVE_CONTROL_ADDRESS", "Primitive"),
  worker: need(c, "workerAddress", "PRIMITIVE_WORKER_ADDRESS", "Primitive"),
});
export const requirePrimitiveWebhookSecret = (c: Config) => need(c, "primitiveWebhookSecret", "PRIMITIVE_WEBHOOK_SECRET", "Primitive webhooks");

/** Stable MPP challenge-signing secret: explicit, else derived from the Stripe key (per Stripe docs). */
export function mppSecret(c: Config): string {
  if (c.mppSecretKey) return c.mppSecretKey;
  const { secretKey } = requireStripe(c);
  return createHmac("sha256", secretKey).update("mpp-challenge-signing").digest("base64");
}

export function integrationStatus(c: Config) {
  return {
    database: !!c.databaseUrl,
    storage: !!(c.supabaseUrl && c.supabaseServiceRoleKey),
    stripe: !!(c.stripeSecretKey && (c.stripeProfileId || (c.paymentsMode === "test" && c.stripeTestNetworkId === "internal"))),
    stripe_webhook: !!c.stripeWebhookSecret,
    primitive: !!(c.primitiveApiKey && c.controlAddress && c.workerAddress),
    primitive_webhook: !!c.primitiveWebhookSecret,
    access_pepper: !!c.pepper,
    worker_tokens: !!c.workerTokenSecret,
    internal_tick: !!c.internalTickToken,
  };
}
