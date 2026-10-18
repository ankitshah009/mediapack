import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { parseConfig } from "../src/config.js";
import { createSql } from "../src/db.js";
import { createPrimitiveAdapter } from "../src/adapters/primitive.js";
import type { StorageAdapter } from "../src/adapters/storage.js";
import { INDEXER_VERSION, JobView, PACK, Quote } from "../src/contracts/index.js";
import { buildHttpApp } from "../src/http-app.js";
import { drain, type Ctx } from "../src/services/ctx.js";
import { demoPurchase } from "../src/services/demoBuyer.js";
import { AppError } from "../src/services/errors.js";
import { startFakeStripe, type FakeStripe } from "./helpers/fake-stripe.js";
import { startPostgres } from "./helpers/postgres.js";

// The whole MPP flow is real here: mppx client -> purchase() -> mppx server -> Stripe SDK -> Postgres.
// Only Stripe's HTTP API is replaced (tests/helpers/fake-stripe.ts), and Primitive/Storage are inert stubs.
const ORIGIN = "http://localhost:3000";
const KEY = "sk_test_demo_buyer_fixture_only";
const CAP_HINT = "The daily demo purchase limit is reached. Pay from your own agent (see the CLI instructions) or try again later.";

interface Deployment { app: ReturnType<typeof buildHttpApp>["app"]; ctx: Ctx }
interface Session { cookie: string; clientId: string }

let postgres: Awaited<ReturnType<typeof startPostgres>>;
let fake: FakeStripe;
let on: Deployment;    // demo buyer enabled, default caps (2 per client, 100 global)
let off: Deployment;   // same deployment with the flag unset
let tight: Deployment; // enabled, but only one purchase per day across all clients
const deployments: Deployment[] = [];

const storage: StorageAdapter = {
  bucket: "test-private",
  async createUpload() { throw new Error("storage is not used by these tests"); },
  async createDownloadUrl(key) { return `https://storage.invalid/${key}`; },
  async createDownloadUrls(keys) { return Object.fromEntries(keys.map((key) => [key, `https://storage.invalid/${key}`])); },
  async stat() { return null; },
  async download() { throw new Error("storage is not used by these tests"); },
  async remove() {},
};

function deploy(env: Record<string, string> = {}): Deployment {
  const cfg = parseConfig({
    NODE_ENV: "test", PUBLIC_BASE_URL: ORIGIN, DATABASE_URL: postgres.url,
    CAPABILITY_PEPPER: "demo-buyer-test-capability-pepper", WORKER_TOKEN_SECRET: "demo-buyer-test-worker-secret",
    INTERNAL_TICK_TOKEN: "demo-buyer-test-tick-token", STRIPE_SECRET_KEY: KEY, STRIPE_TEST_NETWORK_ID: "internal",
    STRIPE_API_BASE: fake.url, STRIPE_WEBHOOK_SECRET: "whsec_demo_buyer_test_only",
    MPP_SECRET_KEY: "demo-buyer-test-mpp-signing-secret-at-least-32-characters",
    PRIMITIVE_API_KEY: "dummy_demo_buyer_only", PRIMITIVE_WEBHOOK_SECRET: "primitive_demo_buyer_only",
    PRIMITIVE_CONTROL_ADDRESS: "control@test.invalid", PRIMITIVE_WORKER_ADDRESS: "worker@test.invalid",
    SOURCE_CLIENTS_PER_HOUR: "10000", GLOBAL_CLIENTS_PER_HOUR: "10000", ...env,
  });
  const primitive = createPrimitiveAdapter(cfg);
  const built = buildHttpApp({
    cfg, sql: createSql(cfg), storage, background: new Set(),
    primitive: { ...primitive, async send() { return { id: "sent_demo_buyer_test" }; } },
    async launchWorker() { return { sandboxName: "sandbox-demo-buyer-test", processName: "process-demo-buyer-test" }; },
  });
  deployments.push(built);
  return built;
}

before(async () => {
  postgres = await startPostgres();
  fake = await startFakeStripe();
  on = deploy({ DEMO_BUYER_ENABLED: "true" });
  off = deploy();
  tight = deploy({ DEMO_BUYER_ENABLED: "true", DEMO_BUYER_GLOBAL_DAILY: "1" });
});

after(async () => {
  for (const d of deployments) { await drain(d.ctx); await d.ctx.sql.end({ timeout: 5 }); }
  await fake?.close();
  postgres?.stop();
});

beforeEach(async () => {
  for (const d of deployments) await drain(d.ctx);
  await on.ctx.sql`truncate clients, provider_events, rate_counters restart identity cascade`;
  fake.reset();
});

async function call(d: Deployment, method: "GET" | "POST", path: string, opts: { cookie?: string; origin?: string | null; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.cookie) headers.cookie = opts.cookie;
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (origin && method === "POST") headers.origin = origin;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const response = await d.app.request(`${ORIGIN}${path}`, { method, headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) });
  return { response, body: await response.json() as any };
}

/** A browser that bootstrapped its own client, exactly as the dashboard does on first upload. */
async function browser(d: Deployment = on): Promise<Session> {
  const r = await call(d, "POST", "/viewer/bootstrap");
  assert.equal(r.response.status, 201, JSON.stringify(r.body));
  return { cookie: r.response.headers.get("set-cookie")!.split(";")[0]!, clientId: r.body.client_id };
}

/** A video that already passed preflight (the worker is out of scope here); the quote then comes from the real API. */
async function readyVideo(clientId: string) {
  const sha = createHash("sha256").update(randomUUID()).digest("hex");
  const [video] = await on.ctx.sql`
    insert into videos (client_id, original_filename, object_key, declared_size_bytes, size_bytes, sha256, duration_ms, width, height, rotation, audio, state, upload_expires_at)
    values (${clientId}::uuid, 'recording.mp4', ${`${randomUUID()}/source.mp4`}, 1024, 1024, ${sha}, 60000, 1280, 720, 0, 'absent', 'ready', now() + interval '1 hour')
    returning id, sha256`;
  return video as { id: string; sha256: string };
}

async function newQuote(session: Session, d: Deployment = on): Promise<Quote> {
  const video = await readyVideo(session.clientId);
  const r = await call(d, "POST", `/v1/videos/${video.id}/quotes`, { cookie: session.cookie, body: { request_id: randomUUID() } });
  assert.equal(r.response.status, 201, JSON.stringify(r.body));
  return Quote.parse(r.body);
}

/** A quote with deliberately unusual terms, frozen through the same SQL function the API uses. */
async function oddJob(session: Session, terms: Partial<{ amount_minor: number; payment_mode: string; expires_at: string }>): Promise<string> {
  const video = await readyVideo(session.clientId);
  const frozen = {
    source_sha256: video.sha256, amount_minor: 50, currency: "usd", payment_mode: "test", limits: PACK.limits, pack_ttl_seconds: PACK.ttlSeconds,
    indexer_version: INDEXER_VERSION, terms_hash: randomUUID(), expires_at: new Date(Date.now() + 600_000).toISOString(), ...terms,
  };
  const [ids] = await on.ctx.sql`select * from create_quote_and_job(${session.clientId}::uuid, ${video.id}::uuid, ${on.ctx.sql.json(frozen)})`;
  return ids!.job_id as string;
}

const demoPay = (jobId: string, session: Session, d: Deployment = on, opts: { origin?: string | null } = {}) =>
  call(d, "POST", `/viewer/jobs/${jobId}/demo-purchase`, { cookie: session.cookie, ...opts });
const attempts = (jobId: string) => on.ctx.sql`select state, source, payment_intent_id from payment_attempts where job_id = ${jobId}::uuid order by created_at`;

test("the dashboard learns from /viewer/me whether the demo agent exists, signed in or not", async () => {
  const session = await browser();
  assert.deepEqual((await call(on, "GET", "/viewer/me", { cookie: session.cookie })).body, { authenticated: true, client_id: session.clientId, demo_buyer: true });
  assert.deepEqual((await call(on, "GET", "/viewer/me")).body, { authenticated: false, demo_buyer: true });
  assert.deepEqual((await call(off, "GET", "/viewer/me", { cookie: session.cookie })).body, { authenticated: true, client_id: session.clientId, demo_buyer: false });
  assert.deepEqual((await call(off, "GET", "/viewer/me")).body, { authenticated: false, demo_buyer: false });
});

test("a deployment without the demo agent answers NOT_FOUND in the standard envelope and never contacts Stripe", async () => {
  const session = await browser(off);
  const quote = await newQuote(session, off);
  const r = await demoPay(quote.job_id, session, off);
  assert.equal(r.response.status, 404);
  assert.equal(r.body.error.code, "NOT_FOUND");
  assert.equal(r.body.error.retryable, false);
  assert.equal(r.body.hint, "Demo buyer is not enabled on this deployment.");
  assert.ok(r.body.next_action);
  assert.equal(fake.traffic, 0);
  assert.equal(JobView.parse((await call(off, "GET", `/v1/jobs/${quote.job_id}`, { cookie: session.cookie })).body).payment_state, "unpaid");
});

test("the demo agent pays a session's own quote through the real MPP flow and the job is an ordinary paid job", async () => {
  const session = await browser();
  const quote = await newQuote(session);
  const r = await demoPay(quote.job_id, session);
  assert.equal(r.response.status, 200, JSON.stringify(r.body));
  assert.equal(r.response.headers.get("cache-control"), "no-store");
  const view = JobView.parse(r.body);
  assert.equal(view.job_id, quote.job_id);
  assert.equal(view.payment_state, "paid");
  assert.equal(view.state, "indexing");
  assert.equal(view.payment_intent_id, "pi_fake_1");
  assert.ok(view.paid_at);
  assert.ok(view.pack_expires_at);

  // The sandbox shared token was minted once, from the merchant's own test key, bound to this quote on the internal network.
  assert.equal(fake.mints.length, 1);
  const mint = fake.mints[0]!;
  assert.equal(mint.headers.authorization, `Basic ${Buffer.from(`${KEY}:`).toString("base64")}`);
  assert.equal(mint.headers["stripe-version"], "2026-07-29.preview");
  assert.equal(mint.headers["content-type"], "application/x-www-form-urlencoded");
  assert.deepEqual({
    method: mint.form.get("payment_method"), currency: mint.form.get("usage_limits[currency]"),
    max: mint.form.get("usage_limits[max_amount]"), network: mint.form.get("seller_details[network_id]"),
  }, { method: "pm_card_visa", currency: "usd", max: "50", network: "internal" });
  assert.ok(Number(mint.form.get("usage_limits[expires_at]")) > Date.now() / 1000, "the token expires at the challenge expiry, in the future");

  // The charge is the server's own PaymentIntent for that token, carrying the trusted job binding.
  assert.equal(fake.charges.length, 1);
  const charge = fake.charges[0]!;
  assert.equal(charge.form.get("amount"), "50");
  assert.equal(charge.form.get("currency"), "usd");
  assert.equal(charge.form.get("shared_payment_granted_token"), "spt_fake_1");
  assert.equal(charge.form.get("metadata[job_id]"), quote.job_id);
  assert.equal(charge.form.get("metadata[quote_id]"), quote.quote_id);
  assert.equal(charge.form.get("metadata[terms_hash]"), quote.terms_hash);
  assert.match(charge.form.get("metadata[attempt_id]") ?? "", /^[0-9a-f-]{36}$/);
  assert.ok(fake.retrievals.includes("pi_fake_1"), "the PaymentIntent is re-read from Stripe before it is trusted");

  // Persisted exactly like a CLI purchase: one succeeded MPP attempt, a payment.verified event, indexing queued.
  assert.deepEqual((await attempts(quote.job_id)).map((a) => [a.state, a.source, a.payment_intent_id]), [["succeeded", "mpp", "pi_fake_1"]]);
  const kinds = (await on.ctx.sql`select kind from job_events where job_id = ${quote.job_id}::uuid`).map((e) => e.kind);
  assert.ok(kinds.includes("payment.verified"));
  assert.equal(Number((await on.ctx.sql`select count(*) as n from operations where job_id = ${quote.job_id}::uuid and kind = 'index_video'`)[0]!.n), 1);

  // Neither the merchant key nor the shared token ever leaves the server.
  const wire = JSON.stringify(r.body);
  assert.ok(!wire.includes(KEY) && !wire.includes("spt_fake") && !wire.includes("sk_test_"));
});

test("a repeat on a paid job returns the same view and never contacts Stripe again", async () => {
  const session = await browser();
  const quote = await newQuote(session);
  const first = await demoPay(quote.job_id, session);
  assert.equal(first.body.payment_state, "paid");
  const traffic = fake.traffic;
  const again = await demoPay(quote.job_id, session);
  assert.equal(again.response.status, 200);
  assert.equal(JobView.parse(again.body).payment_state, "paid");
  assert.equal(again.body.payment_intent_id, first.body.payment_intent_id);
  assert.equal(fake.traffic, traffic);
  assert.equal((await attempts(quote.job_id)).length, 1);
});

test("a payment already being reconciled is reported, never repeated", async () => {
  const session = await browser();
  const quote = await newQuote(session);
  await on.ctx.sql`insert into payment_attempts (job_id, state, terms_hash, source) values (${quote.job_id}::uuid, 'unknown', ${quote.terms_hash}, 'mpp')`;
  const r = await demoPay(quote.job_id, session);
  assert.equal(r.response.status, 200, JSON.stringify(r.body));
  const view = JobView.parse(r.body);
  assert.equal(view.payment_state, "reconciling");
  assert.match(view.next_action, /Do not pay again/);
  assert.equal(fake.traffic, 0);
  assert.equal((await attempts(quote.job_id)).length, 1);
});

test("the per-client daily cap refuses with 429, ignores reservations older than 24 hours, and spends no Stripe call", async () => {
  const session = await browser();
  const [first, second, third] = [await newQuote(session), await newQuote(session), await newQuote(session)];
  assert.equal((await demoPay(first.job_id, session)).body.payment_state, "paid");
  assert.equal((await demoPay(second.job_id, session)).body.payment_state, "paid");
  const traffic = fake.traffic;

  const refused = await demoPay(third.job_id, session);
  assert.equal(refused.response.status, 429, JSON.stringify(refused.body));
  assert.equal(refused.response.headers.get("retry-after"), "3600");
  assert.equal(refused.body.error.code, "ALLOWANCE_EXCEEDED");
  assert.equal(refused.body.error.retry_after_seconds, 3600);
  assert.equal(refused.body.error.next_action, "Use the CLI buyer shown under the quote.");
  assert.equal(refused.body.hint, CAP_HINT);
  assert.equal(refused.body.next_action, "Use the CLI buyer shown under the quote.");
  assert.equal(fake.traffic, traffic);
  assert.equal((await attempts(third.job_id)).length, 0);
  assert.equal(JobView.parse((await call(on, "GET", `/v1/jobs/${third.job_id}`, { cookie: session.cookie })).body).payment_state, "unpaid");

  // A replay is not a new purchase: a job that is already paid still answers 200 while the client is at its cap.
  const replay = await demoPay(first.job_id, session);
  assert.equal(replay.response.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.payment_state, "paid");
  assert.equal(fake.traffic, traffic);

  // A different browser is not affected by this client's cap.
  const other = await browser();
  assert.equal((await demoPay((await newQuote(other)).job_id, other)).body.payment_state, "paid");

  // The window is rolling: once the first purchase is older than 24 hours, the third fits.
  await on.ctx.sql`update demo_purchases set created_at = now() - interval '25 hours' where job_id = ${first.job_id}::uuid`;
  const allowed = await demoPay(third.job_id, session);
  assert.equal(allowed.response.status, 200, JSON.stringify(allowed.body));
  assert.equal(allowed.body.payment_state, "paid");
});

test("the global daily cap applies across clients", async () => {
  const [a, b] = [await browser(tight), await browser(tight)];
  assert.equal((await demoPay((await newQuote(a)).job_id, a, tight)).body.payment_state, "paid");
  const quote = await newQuote(b);
  const refused = await demoPay(quote.job_id, b, tight);
  assert.equal(refused.response.status, 429, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, "ALLOWANCE_EXCEEDED");
  assert.equal(refused.body.hint, CAP_HINT);
  assert.equal(fake.mints.length, 1);
  assert.equal((await attempts(quote.job_id)).length, 0);
});

test("a burst of parallel purchases for different jobs cannot overshoot the cap", async () => {
  const session = await browser();
  const quotes = [await newQuote(session), await newQuote(session), await newQuote(session)];
  fake.behavior.mintDelayMs = 250; // keeps all three in flight together
  const results = await Promise.all(quotes.map((q) => demoPay(q.job_id, session)));
  assert.deepEqual(results.map((r) => r.response.status).sort(), [200, 200, 429]);
  assert.equal(fake.mints.length, 2);
  assert.equal(fake.charges.length, 2);
  const [row] = await on.ctx.sql`select count(*)::int as n from payment_attempts where state = 'succeeded'`;
  assert.equal(row!.n, 2);
});

test("a payment in flight that has already reserved its attempt counts once toward the cap, not twice", async () => {
  const session = await browser();
  const [slow, next] = [await newQuote(session), await newQuote(session)];
  fake.behavior.chargeDelayMs = 400; // the attempt row exists (submitting) while Stripe is still answering
  const first = demoPay(slow.job_id, session);
  try {
    for (let waited = 0; fake.charges.length === 0 && waited < 50; waited++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fake.charges.length, 1, "the first payment reached the charge step");
    assert.deepEqual((await attempts(slow.job_id)).map((a) => a.state), ["submitting"]);
    const second = await demoPay(next.job_id, session); // 1 reserved + 1 new = 2, which is exactly the cap
    assert.equal(second.response.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.payment_state, "paid");
  } finally {
    assert.equal((await first).response.status, 200); // never leave a payment running into the next test
  }
});

test("parallel clicks on one job share a single payment", async () => {
  const session = await browser();
  const quote = await newQuote(session);
  fake.behavior.mintDelayMs = 150;
  const results = await Promise.all([1, 2, 3, 4].map(() => demoPay(quote.job_id, session)));
  assert.ok(results.every((r) => r.response.status === 200), JSON.stringify(results.map((r) => r.body)));
  assert.ok(results.every((r) => r.body.payment_state === "paid" && r.body.payment_intent_id === "pi_fake_1"));
  assert.equal(fake.mints.length, 1);
  assert.equal(fake.charges.length, 1);
  assert.equal((await attempts(quote.job_id)).length, 1);
});

test("only the owner can run the demo agent, and cookies need an allowed Origin", async () => {
  const owner = await browser();
  const stranger = await browser();
  const quote = await newQuote(owner);
  const path = `/viewer/jobs/${quote.job_id}/demo-purchase`;

  const foreign = await demoPay(quote.job_id, stranger);
  assert.equal(foreign.response.status, 404);
  assert.equal(foreign.body.error.code, "NOT_FOUND");
  assert.equal((await call(on, "POST", path)).response.status, 401);
  const noOrigin = await demoPay(quote.job_id, owner, on, { origin: null });
  assert.equal(noOrigin.response.status, 403, JSON.stringify(noOrigin.body));
  const hostile = await demoPay(quote.job_id, owner, on, { origin: "https://hostile.invalid" });
  assert.equal(hostile.response.status, 403);
  assert.equal((await demoPay("not-a-uuid", owner)).response.status, 404);
  assert.equal((await demoPay(randomUUID(), owner)).response.status, 404);
  assert.equal(fake.traffic, 0);
  assert.equal(JobView.parse((await call(on, "GET", `/v1/jobs/${quote.job_id}`, { cookie: owner.cookie })).body).payment_state, "unpaid");
});

test("the demo agent only pays the unexpired USD 0.50 test pack, and says so before touching Stripe", async () => {
  const session = await browser();
  const live = await demoPay(await oddJob(session, { payment_mode: "live" }), session);
  assert.equal(live.response.status, 400, JSON.stringify(live.body));
  assert.equal(live.body.error.code, "BAD_REQUEST");
  assert.match(live.body.hint, /only pays the USD 0\.50 Stripe sandbox pack/);
  const pricey = await demoPay(await oddJob(session, { amount_minor: 51 }), session);
  assert.equal(pricey.response.status, 400);
  const expired = await demoPay(await oddJob(session, { expires_at: new Date(Date.now() - 1000).toISOString() }), session);
  assert.equal(expired.response.status, 410, JSON.stringify(expired.body));
  assert.equal(expired.body.error.code, "QUOTE_EXPIRED");
  assert.equal(expired.body.error.next_action, "quote_video");
  assert.equal(fake.traffic, 0);
});

test("a rejected token request consumes the reservation across application restarts", async () => {
  const session = await browser(), quote = await newQuote(session);
  fake.behavior.mintFailure = { status: 401, body: { error: { message: `Invalid API Key provided: ${KEY}` } } };
  const failed = await demoPay(quote.job_id, session);
  assert.equal(failed.response.status, 502, JSON.stringify(failed.body));
  assert.equal(failed.body.error.retryable, false);
  assert.match(failed.body.hint, /HTTP 401/);
  assert.ok(!JSON.stringify(failed.body).includes(KEY));
  assert.equal(fake.charges.length, 0);
  assert.equal((await attempts(quote.job_id)).length, 0);
  assert.equal((await on.ctx.sql`select state from demo_purchases where quote_id = ${quote.quote_id}::uuid`)[0]!.state, "failed");
  fake.behavior.mintFailure = undefined;
  const restarted = deploy({ DEMO_BUYER_ENABLED: "true" });
  const retry = await demoPay(quote.job_id, session, restarted);
  assert.equal(retry.response.status, 409, JSON.stringify(retry.body));
  assert.equal(retry.body.error.code, "PAYMENT_RECONCILING");
  assert.equal(retry.body.error.retryable, false);
  assert.match(retry.body.next_action, /do not pay this quote again/);
  assert.equal(fake.mints.length, 1);
});

test("a declined sandbox charge consumes the demo reservation permanently", async () => {
  const session = await browser(), quote = await newQuote(session);
  fake.behavior.chargeFailure = { status: 402, body: { error: { type: "card_error", code: "card_declined", message: "Your card was declined." } } };
  const declined = await demoPay(quote.job_id, session);
  assert.equal(declined.response.status, 402, JSON.stringify(declined.body));
  assert.equal(declined.body.error.code, "PAYMENT_REQUIRED");
  assert.equal(declined.body.error.retryable, false);
  assert.deepEqual((await attempts(quote.job_id)).map((a) => a.state), ["failed"]);
  fake.behavior.chargeFailure = undefined;
  assert.equal((await demoPay(quote.job_id, session)).response.status, 409);
  assert.equal(fake.mints.length, 1);
  assert.equal(fake.charges.length, 1);
});

test("an aborted token request stays consumed and a late provider response cannot charge", async () => {
  const session = await browser(), quote = await newQuote(session);
  fake.behavior.mintDelayMs = 500;
  await assert.rejects(demoPurchase(on.ctx, session.clientId, quote.job_id, { deadlineMs: 100 }), (error) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.status, 504);
    assert.equal(error.opts.retryable, false);
    return true;
  });
  const retry = await demoPay(quote.job_id, session, deploy({ DEMO_BUYER_ENABLED: "true" }));
  assert.equal(retry.response.status, 409);
  assert.equal(retry.body.error.code, "PAYMENT_RECONCILING");
  await new Promise((r) => setTimeout(r, 550));
  assert.equal(fake.mints.length, 1);
  assert.equal(fake.charges.length, 0);
  assert.equal((await attempts(quote.job_id)).length, 0);
  assert.equal((await on.ctx.sql`select state from demo_purchases where quote_id = ${quote.quote_id}::uuid`)[0]!.state, "unknown");
});

test("a deadline during charge awaits the merchant outcome without detaching or issuing another token", async () => {
  const session = await browser(), quote = await newQuote(session);
  fake.behavior.chargeDelayMs = 450;
  let settled = false;
  const first = demoPurchase(on.ctx, session.clientId, quote.job_id, { deadlineMs: 100 }).finally(() => { settled = true; });
  try {
    for (let i = 0; fake.charges.length === 0 && i < 100; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(fake.charges.length, 1);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(settled, false, "the deadline does not detach a submitted charge");
    const repeat = await demoPay(quote.job_id, session, deploy({ DEMO_BUYER_ENABLED: "true" }));
    assert.equal(repeat.response.status, 200);
    assert.equal(repeat.body.payment_state, "reconciling");
  } finally { assert.equal((await first).payment_state, "paid"); }
  assert.equal(fake.mints.length, 1);
  assert.equal(fake.charges.length, 1);
});

test("parallel independent application contexts cannot mint twice for one quote", async () => {
  const session = await browser(), quote = await newQuote(session);
  const other = deploy({ DEMO_BUYER_ENABLED: "true" });
  fake.behavior.mintDelayMs = 150;
  const results = await Promise.all([demoPay(quote.job_id, session), demoPay(quote.job_id, session, other)]);
  assert.deepEqual(results.map((r) => r.response.status).sort(), [200, 409]);
  assert.equal(results.find((r) => r.response.status === 409)!.body.error.code, "PAYMENT_RECONCILING");
  assert.equal(fake.mints.length, 1);
  assert.equal(fake.charges.length, 1);
});

test("durable global caps serialize independent contexts before any merchant attempt exists", async () => {
  const a = await browser(tight), b = await browser(tight), qa = await newQuote(a), qb = await newQuote(b);
  const other = deploy({ DEMO_BUYER_ENABLED: "true", DEMO_BUYER_GLOBAL_DAILY: "1" });
  fake.behavior.mintDelayMs = 100;
  fake.behavior.mintFailure = { status: 503, body: { error: { message: "fixture uncertainty" } } };
  const results = await Promise.all([demoPay(qa.job_id, a, tight), demoPay(qb.job_id, b, other)]);
  assert.deepEqual(results.map((r) => r.response.status).sort(), [429, 502]);
  assert.equal(fake.mints.length, 1);
  assert.equal(fake.charges.length, 0);
  assert.equal((await on.ctx.sql`select count(*)::int as n from demo_purchases`)[0]!.n, 1);
  assert.equal((await on.ctx.sql`select count(*)::int as n from payment_attempts`)[0]!.n, 0);
});

test("the browser-only route rejects owner capabilities even alongside a valid session", async () => {
  const created = await call(on, "POST", "/v1/clients", { body: {} });
  assert.equal(created.response.status, 201);
  const session = await browser(), quote = await newQuote(session);
  const path = `/viewer/jobs/${quote.job_id}/demo-purchase`;
  for (const cookie of [undefined, session.cookie]) {
    const r = await call(on, "POST", path, { ...(cookie ? { cookie } : {}), origin: null, headers: { "x-mediapack-token": created.body.capability } });
    assert.equal(r.response.status, 401);
    assert.match(r.body.hint, /signed browser session/);
  }
  assert.equal((await call(on, "POST", path, { cookie: session.cookie + "tampered" })).response.status, 401);
  assert.equal(fake.traffic, 0);
});

test("missing durable reservation setup fails actionably before token issuance", async () => {
  const session = await browser(), quote = await newQuote(session);
  await on.ctx.sql`alter function reserve_demo_purchase(uuid, uuid, int, int) rename to unavailable_demo_reservation`;
  try {
    const result = await demoPay(quote.job_id, session);
    assert.equal(result.response.status, 503);
    assert.match(result.body.hint, /apply the demo buyer migration/);
    assert.equal(fake.traffic, 0);
  } finally {
    await on.ctx.sql`alter function unavailable_demo_reservation(uuid, uuid, int, int) rename to reserve_demo_purchase`;
  }
});
