// Webhooks, internal tick/worker routes, health, llms.txt, static UI.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { RouteHost } from "./http.js";
import { z } from "zod";
import { integrationStatus, requireTickToken } from "../config.js";
import { INDEXER_VERSION, INPUT_LIMITS, PACK } from "../contracts/index.js";
import { AppError } from "../services/errors.js";
import { safeEqual } from "../services/crypto.js";
import { artifactAccess, verifyWorkerToken } from "../services/workerTokens.js";
import { handlePrimitiveWebhook, reprocessPendingEvents } from "../services/inbox.js";
import { dispatchOutbox } from "../services/outbox.js";
import { handleStripeWebhook, reconcilePayments } from "../services/payments.js";
import { sweepExpiredUploads } from "../services/videos.js";
import type { Ctx } from "../services/ctx.js";
import { errorResponse, guard } from "./http.js";

const bearer = (v: string | undefined) => (v && /^bearer\s+/i.test(v) ? v.replace(/^bearer\s+/i, "").trim() : undefined);

export function registerSystem(server: RouteHost, ctx: Ctx, { serveStatic = true } = {}) {
  server.get("/health", async (c) => {
    const cfg = ctx.cfg;
    let db: "ok" | "unconfigured" | "error" = "unconfigured";
    if (cfg.databaseUrl) {
      try {
        await Promise.race([ctx.sql`select 1`, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 1500).unref())]);
        db = "ok";
      } catch { db = "error"; }
    }
    return c.json({ ok: db !== "error", service: "mediapack", indexer_version: INDEXER_VERSION, payments_mode: cfg.paymentsMode, database: db, integrations: integrationStatus(cfg) });
  });

  server.get("/llms.txt", (c) => c.text(llmsTxt(ctx.cfg.publicOrigin, ctx.cfg.mcpPublicUrl), 200, { "content-type": "text/plain; charset=utf-8" }));

  // ── webhooks (raw bodies) ──
  server.post("/webhooks/stripe", async (c) => {
    try { return await handleStripeWebhook(ctx, await c.req.text(), c.req.header("stripe-signature")); }
    catch (e) { return errorResponse(c, e); }
  });
  server.post("/webhooks/primitive", async (c) => {
    try { return await handlePrimitiveWebhook(ctx, Buffer.from(await c.req.arrayBuffer()), c.req.header("primitive-signature")); }
    catch (e) { return errorResponse(c, e); }
  });

  // ── internal ──
  server.post("/internal/tick", guard(async (c) => {
    const token = bearer(c.req.header("authorization"));
    if (!token || !safeEqual(token, requireTickToken(ctx.cfg))) throw new AppError("UNAUTHORIZED", "Invalid tick token.");
    const reaped = (await ctx.sql`select reap_stale_operations(20) as n`)[0]!.n as number;
    const expired_uploads = await sweepExpiredUploads(ctx);
    const events = await reprocessPendingEvents(ctx).catch((e) => (console.error("[tick] events", e.message), -1));
    const payments = await reconcilePayments(ctx).catch((e) => (console.error("[tick] payments", e.message), null));
    const outbox = await dispatchOutbox(ctx, 20);
    return c.json({ ok: true, reaped, expired_uploads, reprocessed_events: events, payments, outbox });
  }));

  server.post("/internal/operations/:operation_id/artifact-access", guard(async (c) => {
    const claims = verifyWorkerToken(ctx, bearer(c.req.header("authorization")));
    if (claims.op !== c.req.param("operation_id")) throw new AppError("UNAUTHORIZED", "Worker token is for a different operation.");
    let raw: unknown = {};
    try { raw = await c.req.json(); } catch { /* empty */ }
    const body = z.object({
      uploads: z.array(z.object({ name: z.string().min(1).max(200), content_type: z.string().min(1).max(100) })).max(120).optional(),
      downloads: z.array(z.enum(["source", "index"])).max(2).optional(),
    }).safeParse(raw);
    if (!body.success) throw new AppError("BAD_REQUEST", "Invalid artifact-access body.");
    return c.json(await artifactAccess(ctx, claims, body.data), 200, { "cache-control": "no-store" });
  }));

  if (serveStatic) registerStatic(server, ctx);
}

// ── static UI ──
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2", ".map": "application/json", ".webp": "image/webp",
};

export function resolveAppDist(override?: string): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [override, resolve(here, "../../app/dist"), resolve(here, "../app/dist"), resolve(here, "app/dist"), resolve(process.cwd(), "app/dist"), resolve(process.cwd(), "apps/mediapack/app/dist")];
  return candidates.find((p): p is string => !!p && existsSync(join(p, "index.html")));
}

function registerStatic(server: RouteHost, ctx: Ctx) {
  const dist = () => resolveAppDist(ctx.cfg.appDistDir);
  server.get("/", (c) => c.redirect("/app/", 302));
  server.get("/app", (c) => c.redirect("/app/", 302));
  server.get("/app/*", (c) => {
    const root = dist();
    if (!root) return c.json({ error: { code: "NOT_FOUND", message: "UI build not found; run `npm run build` in apps/mediapack/app.", retryable: false } }, 404);
    const rel = decodeURIComponent(new URL(c.req.url).pathname.replace(/^\/app\/?/, ""));
    const file = resolve(root, normalize(rel));
    const inside = file === root || file.startsWith(root + sep);
    if (inside && rel && existsSync(file) && statSync(file).isFile()) {
      const hashed = rel.startsWith("assets/");
      return c.body(readFileSync(file), 200, {
        "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
        "cache-control": hashed ? "public, max-age=31536000, immutable" : "public, max-age=300",
      });
    }
    if (extname(rel) && !rel.endsWith(".html")) return c.json({ error: { code: "NOT_FOUND", message: "Not found.", retryable: false } }, 404);
    // SPA fallback (/app/v/*, /app/jobs/*, /app/pair, ...)
    return c.body(readFileSync(join(root, "index.html")), 200, { "content-type": TYPES[".html"]!, "cache-control": "no-cache" });
  });
}

function llmsTxt(origin: string, mcpUrl?: string): string {
  return `# MediaPack

Video search and retrieval for agents. Upload one video, buy one bounded pack (USD ${(PACK.amountMinor / 100).toFixed(2)}, Stripe sandbox),
search spoken content and visible actions, then fetch source frames and clips. One purchase activates one immutable video for 24 hours.

## Pack contents
${PACK.limits.searches} distinct searches, ${PACK.limits.frames} delivered frames, ${PACK.limits.clip_ms / 1000}s of exported clips, ${PACK.limits.text_chars} characters of evidence text.
Limits: MP4/WebM, <= ${INPUT_LIMITS.maxBytes / 1048576} MiB, <= ${INPUT_LIMITS.maxDurationMs / 1000}s, <= 1920x1080 (portrait OK). Audio optional.

## Endpoints
- MCP (streamable HTTP, hosted on Manufact): ${mcpUrl ?? "ask the operator for the separate Manufact /mcp URL (MCP_PUBLIC_URL)"}   header: Authorization: Bearer <client capability>
- REST: ${origin}/v1/...   header: X-MediaPack-Token: <client capability>
- Human viewer: ${origin}/app/

## Flow
1. POST /v1/clients -> {capability} (shown once; 48h). CLI: node scripts/mediapack.mjs bootstrap
2. POST /v1/videos {request_id, file_name, size_bytes, content_type} -> upload {method:PUT, url, headers}; PUT the file bytes there.
3. POST /v1/videos/:id/complete -> probing; poll GET /v1/videos/:id until state is ready (or rejected).
4. POST /v1/videos/:id/quotes -> Quote {quote_id, job_id, amount_minor, purchase_url, terms_hash}.
5. Pay: POST {purchase_url} body {"quote_id":"<uuid>"} header X-MediaPack-Token. Responds 402 (MPP challenge), then 200 with Payment-Receipt.
   Buyer option 1 (default, sandbox): node scripts/mediapack.mjs buy <job_id>   (installed mppx SDK with MPPX_STRIPE_SECRET_KEY=sk_test_...)
   Buyer option 2 (Link):             node scripts/mediapack.mjs buy <job_id> --via link   (link-cli mpp pay <url> --test -X POST -d '{"quote_id":...}')
   202 {payment_state:"reconciling"} means the outcome is being checked: poll GET /v1/jobs/:id, never pay twice.
6. Poll GET /v1/jobs/:id until state is ready (indexing), then
   POST /v1/jobs/:id/searches {request_id, query, max_results}     -> 202 operation; poll GET /v1/jobs/:id
   POST /v1/jobs/:id/frames   {request_id, timestamps_ms:[..]}
   POST /v1/jobs/:id/clips    {request_id, start_ms, end_ms}
   GET  /v1/jobs/:id/pack ; GET /v1/artifacts/:artifact_id/access
7. GET /v1/jobs/:id/events?after=<id> for the factual activity log.

Errors: {"error":{"code","message","retryable","retry_after_seconds?","job_id?","next_action?"}}.
Search can return no match; sampled frames can miss brief events. Evidence is not a judgment about causes or identity.
`;
}
