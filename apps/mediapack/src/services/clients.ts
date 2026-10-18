// Capability clients, viewer pairing, signed viewer sessions.
import { createHmac } from "node:crypto";
import { requirePepper } from "../config.js";
import { INPUT_LIMITS } from "../contracts/index.js";
import { AppError } from "./errors.js";
import { b64url, hmacHex, randomToken, safeEqual } from "./crypto.js";
import type { Ctx } from "./ctx.js";

export const CAPABILITY_PREFIX = "mp_";
const SESSION_TTL_SECONDS = 3 * 24 * 3600;
const PAIR_TTL_SECONDS = 300;

const capHash = (ctx: Ctx, cap: string) => hmacHex(requirePepper(ctx.cfg), `cap:${cap}`);
const pairHash = (ctx: Ctx, code: string) => hmacHex(requirePepper(ctx.cfg), `pair:${code}`);
const sessionKey = (ctx: Ctx) => hmacHex(requirePepper(ctx.cfg), "mediapack-session-v1");

export interface AuthedClient { id: string; via: "token" | "cookie" }

/** Persistent counters (rate_counters) — returns the new count for the hourly window. */
async function bump(ctx: Ctx, key: string): Promise<number> {
  const [row] = await ctx.sql<{ count: number }[]>`
    insert into rate_counters (key, window_start, count)
    values (${key}, date_trunc('hour', now()), 1)
    on conflict (key, window_start) do update set count = rate_counters.count + 1
    returning count`;
  return row!.count;
}

export async function createClient(ctx: Ctx, source: string, displayName?: string) {
  const pepper = requirePepper(ctx.cfg);
  const src = hmacHex(pepper, `src:${source}`).slice(0, 24); // no raw IP stored
  if ((await bump(ctx, `clients:src:${src}`)) > ctx.cfg.sourceClientsPerHour ||
      (await bump(ctx, "clients:global")) > ctx.cfg.globalClientsPerHour) {
    throw new AppError("INPUT_LIMIT_EXCEEDED", "Too many clients created; try again later.", { status: 429, retryAfter: 600, retryable: true });
  }
  const capability = CAPABILITY_PREFIX + randomToken(32); // 256 bits
  const [row] = await ctx.sql<{ id: string; expires_at: Date }[]>`
    insert into clients (capability_hash, display_name, expires_at)
    values (${capHash(ctx, capability)}, ${displayName?.slice(0, 80) ?? null}, now() + make_interval(secs => ${INPUT_LIMITS.clientTtlSeconds}))
    returning id, expires_at`;
  return { client_id: row!.id, capability, expires_at: row!.expires_at.toISOString() };
}

export async function authCapability(ctx: Ctx, cap: string | undefined): Promise<AuthedClient | null> {
  if (!cap || !cap.startsWith(CAPABILITY_PREFIX) || cap.length > 200) return null;
  const rows = await ctx.sql<{ id: string }[]>`
    select id from clients where capability_hash = ${capHash(ctx, cap)} and not revoked and expires_at > now()`;
  return rows[0] ? { id: rows[0].id, via: "token" } : null;
}

// ── viewer session: stateless signed cookie value (we only store a hash of the capability) ──
export function signSession(ctx: Ctx, clientId: string, ttl = SESSION_TTL_SECONDS): { value: string; maxAge: number } {
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const body = b64url(JSON.stringify({ c: clientId, e: exp }));
  const sig = createHmac("sha256", sessionKey(ctx)).update(body).digest("base64url");
  return { value: `mps.${body}.${sig}`, maxAge: ttl };
}

export async function authSession(ctx: Ctx, value: string | undefined): Promise<AuthedClient | null> {
  if (!value || !value.startsWith("mps.")) return null;
  const [, body, sig] = value.split(".");
  if (!body || !sig) return null;
  const expect = createHmac("sha256", sessionKey(ctx)).update(body).digest("base64url");
  if (!safeEqual(sig, expect)) return null;
  let p: { c: string; e: number };
  try { p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
  if (typeof p.c !== "string" || typeof p.e !== "number" || p.e < Date.now() / 1000) return null;
  const rows = await ctx.sql<{ id: string }[]>`select id from clients where id = ${p.c}::uuid and not revoked and expires_at > now()`;
  return rows[0] ? { id: rows[0].id, via: "cookie" } : null;
}

export async function createViewerCode(ctx: Ctx, clientId: string) {
  const code = randomToken(16);
  const [row] = await ctx.sql<{ pair_code_expires_at: Date }[]>`
    update clients set pair_code_hash = ${pairHash(ctx, code)},
      pair_code_expires_at = now() + make_interval(secs => ${PAIR_TTL_SECONDS})
    where id = ${clientId}::uuid returning pair_code_expires_at`;
  return { code, expires_at: row!.pair_code_expires_at.toISOString() };
}

/** One-time consumption in a single UPDATE: concurrent redemptions cannot both succeed. */
export async function consumeViewerCode(ctx: Ctx, code: string): Promise<string> {
  const rows = await ctx.sql<{ id: string }[]>`
    update clients set pair_code_hash = null, pair_code_expires_at = null
    where pair_code_hash = ${pairHash(ctx, code)} and pair_code_expires_at > now() and not revoked and expires_at > now()
    returning id`;
  if (!rows[0]) throw new AppError("UNAUTHORIZED", "Pairing code is invalid, expired or already used.");
  return rows[0].id;
}
