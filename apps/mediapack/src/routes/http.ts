// Shared HTTP helpers: error envelope, auth (token header or signed viewer cookie), Origin checks, body parsing.
import type { Context } from "hono";
import type { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { ZodType } from "zod";
import { AppError, toAppError } from "../services/errors.js";
import { authCapability, authSession, type AuthedClient } from "../services/clients.js";
import type { Ctx } from "../services/ctx.js";

export const SESSION_COOKIE = "mp_session";
export const TOKEN_HEADER = "x-mediapack-token";
export type RouteHost = Pick<Hono, "get" | "post">;

export function errorResponse(c: Context, e: unknown, jobId?: string): Response {
  const err = toAppError(e, jobId);
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (err.opts.retryAfter) headers["retry-after"] = String(err.opts.retryAfter);
  return c.json(err.body(), err.status as never, headers);
}

/** Wrap a handler so thrown errors become ErrorBody JSON. */
export function guard<C extends Context>(fn: (c: C) => Promise<Response> | Response) {
  return async (c: C) => {
    try { return await fn(c); } catch (e) { return errorResponse(c, e); }
  };
}

export function assertAllowedOrigin(ctx: Ctx, c: Context) {
  const origin = c.req.header("origin")?.replace(/\/$/, "");
  if (!origin || !ctx.cfg.allowedOrigins.includes(origin)) {
    throw new AppError("UNAUTHORIZED", "Origin not allowed for cookie-authenticated requests.", { status: 403 });
  }
}

/** X-MediaPack-Token first; otherwise the HttpOnly viewer cookie (mutations then require an allowed Origin). */
export async function authenticate(ctx: Ctx, c: Context): Promise<AuthedClient> {
  const token = c.req.header(TOKEN_HEADER);
  if (token) {
    const a = await authCapability(ctx, token);
    if (a) return a;
    throw new AppError("UNAUTHORIZED", "Invalid or expired MediaPack token.");
  }
  const cookie = getCookie(c, SESSION_COOKIE);
  if (cookie) {
    const a = await authSession(ctx, cookie);
    if (a) {
      if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) assertAllowedOrigin(ctx, c);
      return a;
    }
  }
  throw new AppError("UNAUTHORIZED", "Missing or invalid credentials. Send X-MediaPack-Token, or pair a browser session.");
}

export function setSessionCookie(ctx: Ctx, c: Context, value: string, maxAge: number) {
  setCookie(c, SESSION_COOKIE, value, {
    httpOnly: true,
    sameSite: "Lax",
    secure: ctx.cfg.isProd || ctx.cfg.publicOrigin.startsWith("https://"),
    path: "/",
    maxAge,
  });
}
export const clearSessionCookie = (c: Context) => deleteCookie(c, SESSION_COOKIE, { path: "/" });

export async function readBody<T>(c: Context, schema: ZodType<T>, fillRequestId = true): Promise<T> {
  let raw: unknown;
  try { raw = await c.req.json(); } catch { throw new AppError("BAD_REQUEST", "Body must be valid JSON."); }
  if (fillRequestId && raw && typeof raw === "object" && !("request_id" in raw)) {
    const idem = c.req.header("idempotency-key");
    if (idem) (raw as Record<string, unknown>).request_id = idem;
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new AppError("BAD_REQUEST", `${i?.path.join(".") || "body"}: ${i?.message ?? "invalid"}`);
  }
  return r.data;
}

export const sourceOf = (c: Context) => c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown";
