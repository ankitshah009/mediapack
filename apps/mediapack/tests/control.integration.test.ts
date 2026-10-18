import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import Stripe from "stripe";
import { signWebhookPayload } from "@primitivedotdev/sdk";
import { parseConfig } from "../src/config.js";
import { createSql } from "../src/db.js";
import { createPrimitiveAdapter, type OutgoingMail } from "../src/adapters/primitive.js";
import { createStripeAdapter, type ChargeBinding, type ChargeOutcome } from "../src/adapters/stripe.js";
import type { StorageAdapter } from "../src/adapters/storage.js";
import { INDEXER_VERSION, JobView, Quote, sha256Hex } from "../src/contracts/index.js";
import { buildHttpApp } from "../src/http-app.js";
import { drain, type Ctx, type WorkerManifest } from "../src/services/ctx.js";
import { startPostgres } from "./helpers/postgres.js";

const ORIGIN = "http://localhost:3000";
const STRIPE_SECRET = "whsec_control_test_dummy_only";
const PRIMITIVE_SECRET = "primitive_control_test_dummy_only";
const objects = new Map<string, Buffer>();
const mails: Array<Omit<OutgoingMail, "from" | "to"> & { to?: string }> = [];
const launches: WorkerManifest[] = [];
const intents = new Map<string, Stripe.PaymentIntent>();
let postgres: Awaited<ReturnType<typeof startPostgres>>;
let ctx: Ctx;
let app: ReturnType<typeof buildHttpApp>["app"];
let chargeCalls = 0;
let charge: (request: Request, binding: ChargeBinding) => Promise<ChargeOutcome>;

const storage: StorageAdapter = {
  bucket: "test-private",
  async createUpload(key, contentType) { return { method: "PUT", url: `https://storage.invalid/${key}`, headers: { "content-type": contentType }, expires_in_seconds: 3600 }; },
  async createDownloadUrl(key) { return `https://storage.invalid/${key}?signed=test-only`; },
  async createDownloadUrls(keys) { return Object.fromEntries(keys.map((key) => [key, `https://storage.invalid/${key}?signed=test-only`])); },
  async stat(key) { const data = objects.get(key); return data ? { size: data.length } : null; },
  async download(key, maxBytes) { const data = objects.get(key); assert.ok(data, `missing test object ${key}`); assert.ok(data.length <= maxBytes); return data; },
  async remove(keys) { keys.forEach((key) => objects.delete(key)); },
};

before(async () => {
  postgres = await startPostgres();
  const cfg = parseConfig({
    NODE_ENV: "test", PUBLIC_BASE_URL: ORIGIN, DATABASE_URL: postgres.url,
    CAPABILITY_PEPPER: "control-test-capability-pepper-only", WORKER_TOKEN_SECRET: "control-test-worker-secret-only",
    INTERNAL_TICK_TOKEN: "control-test-tick-token-only", STRIPE_SECRET_KEY: "sk_test_dummy_control_only",
    STRIPE_PROFILE_ID: "profile_test_dummy_control_only", STRIPE_WEBHOOK_SECRET: STRIPE_SECRET,
    PRIMITIVE_API_KEY: "dummy_control_only", PRIMITIVE_WEBHOOK_SECRET: PRIMITIVE_SECRET,
    PRIMITIVE_CONTROL_ADDRESS: "control@test.invalid", PRIMITIVE_WORKER_ADDRESS: "worker@test.invalid",
    SOURCE_CLIENTS_PER_HOUR: "10000", GLOBAL_CLIENTS_PER_HOUR: "10000",
  });
  const realPrimitive = createPrimitiveAdapter(cfg);
  const realStripe = createStripeAdapter(cfg);
  const built = buildHttpApp({
    cfg, sql: createSql(cfg), storage, background: new Set(),
    primitive: { ...realPrimitive, async send(mail) { mails.push(mail); return { id: `sent_${mails.length}` }; } },
    stripe: {
      livemode: false, constructEvent: (raw, signature) => realStripe.constructEvent(raw, signature),
      async retrievePaymentIntent(id) { const pi = intents.get(id); assert.ok(pi, `missing test intent ${id}`); return pi; },
      async searchPaymentIntentsByAttempt(attemptId) { return [...intents.values()].filter((pi) => pi.metadata.attempt_id === attemptId); },
      async charge(request, binding) { chargeCalls++; return charge(request, binding); },
    },
    async launchWorker(manifest) { launches.push(manifest); return { sandboxName: `sandbox-${manifest.work_request.operation_id}`, processName: `process-g${manifest.work_request.generation}` }; },
  });
  ctx = built.ctx;
  app = built.app;
});

after(async () => {
  if (ctx) { await drain(ctx); await ctx.sql.end({ timeout: 5 }); }
  postgres?.stop();
});

beforeEach(async () => {
  await drain(ctx);
  await ctx.sql`truncate clients, provider_events, rate_counters restart identity cascade`;
  objects.clear(); mails.length = 0; launches.length = 0; intents.clear(); chargeCalls = 0;
  charge = async (request, binding) => {
    if (!request.headers.get("authorization")?.startsWith("Payment ")) {
      return { status: 402, response: Response.json({ payment: "challenge" }, { status: 402, headers: { "www-authenticate": "Payment test" } }), reachedStripe: false };
    }
    const id = `pi_${randomUUID().replaceAll("-", "")}`;
    intents.set(id, { id, object: "payment_intent", status: "succeeded", amount: binding.amountMinor, currency: binding.currency, livemode: false, metadata: binding.intentMetadata!() } as Stripe.PaymentIntent);
    return { status: 200, reference: id, receiptHeader: "test-receipt", withReceipt(response) { response.headers.set("payment-receipt", "test-receipt"); return response; } };
  };
});

async function request(path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await app.request(`${ORIGIN}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(token ? { "x-mediapack-token": token } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, body: await response.json() as any };
}

async function client() {
  const r = await request("/v1/clients", undefined, { display_name: "integration test" });
  assert.equal(r.response.status, 201, JSON.stringify(r.body));
  return r.body.capability as string;
}

async function upload(token: string, requestId = randomUUID()) {
  const input = { request_id: requestId, file_name: "recording.mp4", size_bytes: 1024, content_type: "video/mp4" };
  const r = await request("/v1/videos", token, input);
  assert.equal(r.response.status, 201, JSON.stringify(r.body));
  const videoId = r.body.video_id as string;
  objects.set(`${videoId}/source.mp4`, Buffer.alloc(1024, 7));
  return { videoId, input };
}

async function deliver(envelope: any, eventId = `ev_${randomUUID()}`, options: { from?: string; to?: string; signature?: string } = {}) {
  const work = envelope.kind === "work_request";
  const raw = JSON.stringify({
    id: eventId, event: "email.received",
    email: {
      id: `email_${eventId}`, thread_id: `thread_${envelope.operation_id}`,
      headers: { subject: `${work ? "" : "Re: "}[mp:${envelope.operation_id}:g${envelope.generation}] work`, from: options.from ?? (work ? "control@test.invalid" : "worker@test.invalid"), to: options.to ?? (work ? "worker@test.invalid" : "control@test.invalid") },
      parsed: { body_text: JSON.stringify(envelope) }, auth: { dmarc: "pass" },
    },
  });
  const response = await app.request(`${ORIGIN}/webhooks/primitive`, { method: "POST", headers: { "content-type": "application/json", "primitive-signature": options.signature ?? signWebhookPayload(raw, PRIMITIVE_SECRET).header }, body: raw });
  return { response, body: await response.json() as any };
}

async function dispatchAndLaunch(opId: string) {
  await drain(ctx);
  const [ob] = await ctx.sql`select payload from outbox where operation_id = ${opId}::uuid order by created_at desc limit 1`;
  assert.ok(ob, "operation has a persisted work request");
  const r = await deliver(ob.payload);
  assert.equal(r.response.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.state, "applied", JSON.stringify(r.body));
  return ob.payload;
}

async function result(opId: string, body: Record<string, unknown>, generation = 1) {
  const r = await deliver({ schema_version: "mediapack.v1", kind: "work_result", operation_id: opId, generation, status: "succeeded", result: body });
  assert.equal(r.response.status, 200, JSON.stringify(r.body));
  return r;
}

async function quoted(token: string) {
  const { videoId } = await upload(token);
  const completed = await request(`/v1/videos/${videoId}/complete`, token, { request_id: randomUUID() });
  assert.equal(completed.response.status, 202, JSON.stringify(completed.body));
  const opId = completed.body.operation_id;
  await dispatchAndLaunch(opId);
  await result(opId, { accepted: true, sha256: sha256Hex(objects.get(`${videoId}/source.mp4`)! ), size_bytes: 1024, duration_ms: 60_000, width: 1280, height: 720, rotation: 0, audio: "absent" });
  const r = await request(`/v1/videos/${videoId}/quotes`, token, { request_id: randomUUID() });
  assert.equal(r.response.status, 201, JSON.stringify(r.body));
  return Quote.parse(r.body);
}

async function paid(token: string) {
  const quote = await quoted(token);
  const r = await request(`/v1/jobs/${quote.job_id}/purchase`, token, { quote_id: quote.quote_id }, { authorization: "Payment dummy-test-credential" });
  assert.equal(r.response.status, 200, JSON.stringify(r.body));
  return quote;
}

async function indexed(token: string) {
  const quote = await paid(token);
  const [op] = await ctx.sql`select id from operations where job_id = ${quote.job_id}::uuid and kind = 'index_video'`;
  await dispatchAndLaunch(op!.id);
  const key = `${quote.video_id}/ops/${op!.id}/g1/index.json`;
  const frameKey = `${quote.video_id}/ops/${op!.id}/g1/frame.jpg`;
  const frameData = Buffer.from("test frame bytes");
  objects.set(frameKey, frameData);
  const data = Buffer.from(JSON.stringify({ indexer_version: INDEXER_VERSION, source_sha256: quote.source_sha256, records: [{ record_id: "f1", kind: "frame", start_ms: 4000, end_ms: 6000, text: "Settings timeout resets to 30", frame_object_key: frameKey }] }));
  objects.set(key, data);
  await result(op!.id, { index_object_key: key, index_sha256: sha256Hex(data), source_sha256: quote.source_sha256, frames: [{ record_id: "f1", object_key: frameKey, sha256: sha256Hex(frameData), frame_ms: 4000, width: 1280, height: 720 }], audio: "absent" });
  const view = await request(`/v1/jobs/${quote.job_id}`, token);
  assert.equal(JobView.parse(view.body).state, "ready", JSON.stringify(view.body));
  return quote;
}

test("capabilities isolate ownership and browser pairing consumes a code exactly once", async () => {
  const token = await client();
  const other = await client();
  const { videoId } = await upload(token);
  assert.equal((await request(`/v1/videos/${videoId}`)).response.status, 401);
  assert.equal((await request(`/v1/videos/${videoId}`, other)).response.status, 404);
  assert.equal((await request(`/v1/artifacts/${videoId}/access`, other)).response.status, 404);
  const paired = await request("/v1/clients/viewer-code", token, {});
  const redeem = () => request("/viewer/session", undefined, { code: paired.body.code }, { origin: ORIGIN });
  const outcomes = await Promise.all([redeem(), redeem()]);
  assert.deepEqual(outcomes.map((r) => r.response.status).sort(), [200, 401]);
  const cookie = outcomes.find((r) => r.response.status === 200)!.response.headers.get("set-cookie")!.split(";")[0]!;
  assert.equal((await request(`/v1/videos/${videoId}`, undefined, undefined, { cookie })).response.status, 200);
  assert.equal((await request("/v1/clients/viewer-code", undefined, {}, { cookie, origin: "https://hostile.invalid" })).response.status, 403);
});

test("upload retry preserves one reservation and rejects changed immutable input", async () => {
  const token = await client();
  const { videoId, input } = await upload(token);
  const same = await request("/v1/videos", token, input);
  assert.equal(same.response.status, 200);
  assert.equal(same.body.video_id, videoId);
  const changed = await request("/v1/videos", token, { ...input, content_type: "video/webm" });
  assert.equal(changed.response.status, 409, JSON.stringify(changed.body));
  assert.equal(changed.body.error.code, "IDEMPOTENCY_CONFLICT");
});

test("Supabase Free upload boundary is enforced before reserving storage or persisting a video", async () => {
  const token = await client();
  const input = { file_name: "at-limit.mp4", size_bytes: 50 * 1024 ** 2, content_type: "video/mp4" };
  const accepted = await request("/v1/videos", token, { ...input, request_id: randomUUID() });
  assert.equal(accepted.response.status, 201, JSON.stringify(accepted.body));
  assert.equal(accepted.body.upload.method, "PUT");
  const rejected = await request("/v1/videos", token, { ...input, size_bytes: input.size_bytes + 1, request_id: randomUUID() });
  assert.equal(rejected.response.status, 400, JSON.stringify(rejected.body));
  assert.equal(rejected.body.error.code, "BAD_REQUEST");
  assert.match(rejected.body.error.message, /size_bytes/);
  assert.ok(rejected.body.hint);
  assert.ok(rejected.body.next_action);
  assert.equal(Number((await ctx.sql`select count(*) as n from videos`)[0]!.n), 1);
});

test("incomplete uploads cannot quote or dispatch and per-client upload cap is atomic", async () => {
  const token = await client();
  const { videoId } = await upload(token);
  objects.clear();
  const incomplete = await request(`/v1/videos/${videoId}/complete`, token, {});
  assert.equal(incomplete.body.error.code, "UPLOAD_INCOMPLETE");
  assert.equal((await request(`/v1/videos/${videoId}/quotes`, token, {})).body.error.code, "VIDEO_NOT_READY");
  const creates = await Promise.all(Array.from({ length: 4 }, () => request("/v1/videos", token, { request_id: randomUUID(), file_name: "a.mp4", size_bytes: 1, content_type: "video/mp4" })));
  assert.equal(creates.filter((r) => r.response.status === 201).length, 2);
  assert.equal(creates.filter((r) => r.response.status === 429).length, 2);
  assert.equal(Number((await ctx.sql`select count(*) as n from outbox`)[0]!.n), 0);
});

test("verified Primitive delivery launches once and fences worker artifact credentials", async () => {
  const token = await client();
  const { videoId } = await upload(token);
  const completed = await request(`/v1/videos/${videoId}/complete`, token, {});
  await drain(ctx);
  const [ob] = await ctx.sql`select payload from outbox where operation_id = ${completed.body.operation_id}::uuid`;
  assert.equal((await deliver(ob!.payload, "bad-signature", { signature: "bad" })).response.status, 401);
  assert.equal((await deliver(ob!.payload, "wrong-sender", { from: "attacker@test.invalid" })).body.state, "ignored");
  assert.equal(launches.length, 0);
  const concurrent = await Promise.all([deliver(ob!.payload, "same-event"), deliver(ob!.payload, "same-event")]);
  assert.ok(concurrent.every((r) => r.response.status === 200));
  assert.equal(launches.length, 1);
  const manifest = launches[0]!;
  assert.equal(manifest.reply_email_id, "email_same-event");
  const access = (name: string) => request(`/internal/operations/${manifest.work_request.operation_id}/artifact-access`, undefined, { uploads: [{ name, content_type: "application/json" }], downloads: ["source"] }, { authorization: `Bearer ${manifest.worker_token}` });
  assert.equal((await access("../escape.json")).response.status, 400);
  assert.equal((await access("probe.json")).response.status, 200);
  await result(completed.body.operation_id, { accepted: false, reject_code: "MEDIA_UNSUPPORTED", reject_message: "Not a supported video" });
  assert.equal((await access("late.json")).response.status, 401);
  const [event] = await ctx.sql`select email_id, thread_id from provider_events where event_id = 'same-event'`;
  assert.equal(event!.email_id, "email_same-event");
  assert.equal(event!.thread_id, `thread_${completed.body.operation_id}`);
});

test("concurrent purchases create one charge and all paid replays return the same receipt", async () => {
  const token = await client();
  const quote = await quoted(token);
  const path = `/v1/jobs/${quote.job_id}/purchase`;
  await ctx.sql`update clients set expires_at = now() + interval '1 hour' where id = (select client_id from jobs where id = ${quote.job_id}::uuid)`;
  const challenge = await request(path, token, { quote_id: quote.quote_id });
  assert.equal(challenge.response.status, 402);
  assert.ok(challenge.response.headers.get("www-authenticate"));
  const beforeCharges = chargeCalls;
  const buys = await Promise.all(Array.from({ length: 8 }, () => request(path, token, { quote_id: quote.quote_id }, { authorization: "Payment same-test-credential" })));
  assert.ok(buys.every((r) => [200, 202].includes(r.response.status)), JSON.stringify(buys.map((r) => r.body)));
  assert.equal(chargeCalls - beforeCharges, 1);
  const [job] = await ctx.sql`select payment_intent_id from jobs where id = ${quote.job_id}::uuid`;
  const replay = await request(path, token, { quote_id: quote.quote_id }, { authorization: "Payment different-credential" });
  assert.equal(replay.body.receipt.reference, job!.payment_intent_id);
  assert.equal(chargeCalls - beforeCharges, 1);
  assert.equal(Number((await ctx.sql`select count(*) as n from operations where kind = 'index_video'`)[0]!.n), 1);
  assert.equal(Number((await ctx.sql`select count(*) as n from outbox where action = 'index_video'`)[0]!.n), 1);
  const [authorization] = await ctx.sql`select c.expires_at >= j.pack_expires_at as covers_pack from clients c join jobs j on j.client_id = c.id where j.id = ${quote.job_id}::uuid`;
  assert.equal(authorization!.covers_pack, true, "payment must preserve access for the full pack lifetime");
});

test("ambiguous payment stays reconciling until a signed Stripe webhook recovers it once", async () => {
  const token = await client();
  const quote = await quoted(token);
  const normalCharge = charge;
  charge = async (r, b) => { await normalCharge(r, b); throw new Error("simulated connection lost after Stripe success"); };
  const buy = await request(`/v1/jobs/${quote.job_id}/purchase`, token, { quote_id: quote.quote_id }, { authorization: "Payment dummy-test-credential" });
  assert.equal(buy.response.status, 202);
  const calls = chargeCalls;
  assert.equal((await request(`/v1/jobs/${quote.job_id}/purchase`, token, { quote_id: quote.quote_id })).response.status, 202);
  assert.equal(chargeCalls, calls, "unknown charge must not create a fresh challenge");
  const pi = [...intents.values()][0]!;
  const raw = JSON.stringify({ id: "evt_crash_recovery", object: "event", type: "payment_intent.succeeded", data: { object: pi } });
  const webhook = () => app.request(`${ORIGIN}/webhooks/stripe`, { method: "POST", headers: { "stripe-signature": Stripe.webhooks.generateTestHeaderString({ payload: raw, secret: STRIPE_SECRET }) }, body: raw });
  const recovered = await Promise.all([webhook(), webhook()]);
  assert.ok(recovered.every((r) => r.status === 200));
  const view = JobView.parse((await request(`/v1/jobs/${quote.job_id}`, token)).body);
  assert.equal(view.payment_state, "paid");
  assert.equal(view.payment_intent_id, pi.id);
  const [attempt] = await ctx.sql`select state from payment_attempts where job_id = ${quote.job_id}::uuid`;
  assert.equal(attempt!.state, "succeeded");
  assert.equal(Number((await ctx.sql`select count(*) as n from operations where kind = 'index_video'`)[0]!.n), 1);
});

test("search completion resolves stored evidence timestamps and counts Unicode text only once", async () => {
  const token = await client();
  const quote = await indexed(token);
  const path = `/v1/jobs/${quote.job_id}/searches`;
  const input = { request_id: randomUUID(), query: "Where does timeout reset?", max_results: 3 };
  const search = await request(path, token, input);
  assert.equal(search.response.status, 202, JSON.stringify(search.body));
  assert.equal((await request(path, token, { ...input, query: "Changed question" })).body.error.code, "IDEMPOTENCY_CONFLICT");
  const opId = search.body.operation_id;
  await dispatchAndLaunch(opId);
  const answer = "The setting resets 🔄.";
  const description = "Timeout changes to 30.";
  const output = { query: "untrusted query", answer, matches: [{ match_id: "model-id", start_ms: 999999, end_ms: 999999, description, modalities: ["visual"], frame_refs: ["f1", "invented"], transcript_refs: [], evidence_status: "supported" }], coverage: { audio: "available", visual_sample_interval_ms: 1, limitations: [] } };
  await result(opId, output);
  await result(opId, output);
  const read = await request(`/v1/jobs/${quote.job_id}/operations/${opId}`, token);
  assert.equal(read.body.state, "succeeded");
  assert.equal(read.body.result.query, input.query);
  assert.equal(read.body.result.coverage.audio, "absent");
  assert.equal(read.body.result.matches[0].start_ms, 4000);
  assert.equal(read.body.result.matches[0].end_ms, 6000);
  assert.equal(read.body.result.matches[0].evidence_status, "partial");
  assert.deepEqual(read.body.result.matches[0].frame_refs, ["f1"]);
  const view = JobView.parse((await request(`/v1/jobs/${quote.job_id}`, token)).body);
  assert.equal(view.used.searches, 1);
  assert.equal(view.used.text_chars, [...answer].length + [...description].length);
  assert.equal(view.reserved.searches, 0);
  const equivalent = await request(path, token, { ...input, request_id: randomUUID(), query: "  where  does timeout reset?  " });
  assert.equal(equivalent.response.status, 200);
  assert.equal(equivalent.body.operation_id, opId);
});

test("parallel frame requests cannot over-reserve the pack and retries keep the original operation", async () => {
  const token = await client();
  const quote = await indexed(token);
  const path = `/v1/jobs/${quote.job_id}/frames`;
  const inputs = [0, 1].map((offset) => ({ request_id: randomUUID(), timestamps_ms: [1000, 2000, 3000, 4000, 5000].map((t) => t + offset * 10) }));
  const outcomes = await Promise.all(inputs.map((input) => request(path, token, input)));
  assert.deepEqual(outcomes.map((r) => r.response.status).sort(), [202, 409]);
  assert.equal(outcomes.find((r) => r.response.status === 409)!.body.error.code, "ALLOWANCE_EXCEEDED");
  const accepted = outcomes.findIndex((r) => r.response.status === 202);
  const retry = await request(path, token, inputs[accepted]);
  assert.equal(retry.body.operation_id, outcomes[accepted]!.body.operation_id);
  const view = JobView.parse((await request(`/v1/jobs/${quote.job_id}`, token)).body);
  assert.equal(view.reserved.frames, 5);
  assert.equal(view.remaining.frames, 3);
});

test("an index from a different source is rejected before publishing artifacts", async () => {
  const token = await client();
  const quote = await paid(token);
  const [op] = await ctx.sql`select id from operations where job_id = ${quote.job_id}::uuid and kind = 'index_video'`;
  await dispatchAndLaunch(op!.id);
  const key = `${quote.video_id}/ops/${op!.id}/g1/index.json`;
  const wrongSource = "f".repeat(64);
  const bytes = Buffer.from(JSON.stringify({ indexer_version: INDEXER_VERSION, source_sha256: wrongSource, records: [] }));
  objects.set(key, bytes);
  await result(op!.id, { index_object_key: key, index_sha256: sha256Hex(bytes), source_sha256: wrongSource, frames: [], audio: "absent" });
  const [current] = await ctx.sql`select generation, state from operations where id = ${op!.id}::uuid`;
  assert.equal(current!.generation, 2);
  assert.notEqual(current!.state, "succeeded");
  assert.equal(Number((await ctx.sql`select count(*) as n from artifacts where job_id = ${quote.job_id}::uuid`)[0]!.n), 0);
  assert.notEqual((await request(`/v1/jobs/${quote.job_id}`, token)).body.state, "ready");
});

test("delivered frames retain requested and decoded timestamps and exact cache hits cost nothing", async () => {
  const token = await client();
  const quote = await indexed(token);
  const path = `/v1/jobs/${quote.job_id}/frames`;
  const input = { request_id: randomUUID(), timestamps_ms: [2000, 1000, 1000] };
  const requested = await request(path, token, input);
  assert.equal(requested.response.status, 202);
  const opId = requested.body.operation_id;
  await dispatchAndLaunch(opId);
  const frames = [1000, 2000].map((t) => {
    const key = `${quote.video_id}/ops/${opId}/g1/${t}.jpg`;
    const bytes = Buffer.from(`frame-${t}`);
    objects.set(key, bytes);
    return { requested_ms: t, actual_ms: t + 17, object_key: key, sha256: sha256Hex(bytes), bytes: bytes.length, width: 1280, height: 720 };
  });
  await result(opId, { frames });
  await result(opId, { frames });
  const cache = await request(path, token, { ...input, request_id: randomUUID() });
  assert.equal(cache.response.status, 200, JSON.stringify(cache.body));
  assert.equal(cache.body.result.artifacts.length, 2);
  const artifact = cache.body.result.artifacts[0];
  assert.equal(artifact.requested_ms.start, 1000);
  assert.equal(artifact.actual_ms.start, 1017);
  const access = await request(`/v1/artifacts/${artifact.artifact_id}/access`, token);
  assert.equal(access.response.status, 200);
  assert.ok(access.body.url.startsWith("https://storage.invalid/"));
  assert.equal((await request(`/v1/artifacts/${artifact.artifact_id}/access`, await client())).response.status, 404);
  const view = JobView.parse((await request(`/v1/jobs/${quote.job_id}`, token)).body);
  assert.equal(view.used.frames, 2);
  assert.equal(view.reserved.frames, 0);
  const pack = await request(`/v1/jobs/${quote.job_id}/pack`, token);
  assert.equal(pack.body.artifacts.length, 2, "index frames must not be exposed as uncharged delivered evidence");
});

test("clip retry is generation fenced and only the measured completed output consumes allowance", async () => {
  const token = await client();
  const quote = await indexed(token);
  const requested = await request(`/v1/jobs/${quote.job_id}/clips`, token, { request_id: randomUUID(), start_ms: 1000, end_ms: 6000 });
  assert.equal(requested.response.status, 202);
  const opId = requested.body.operation_id;
  await dispatchAndLaunch(opId);
  const fail = await deliver({ schema_version: "mediapack.v1", kind: "work_result", operation_id: opId, generation: 1, status: "failed", error: { code: "WORKER_FAILED", message: "temporary worker edge failure", retryable: true } });
  assert.equal(fail.response.status, 200);
  const stale = await result(opId, { clip: {} });
  assert.ok(stale.body.detail.includes("stale"));
  await dispatchAndLaunch(opId);
  const key = `${quote.video_id}/ops/${opId}/g2/clip.mp4`;
  const bytes = Buffer.from("encoded-clip-test-edge");
  objects.set(key, bytes);
  await result(opId, { clip: { requested_start_ms: 1000, requested_end_ms: 6000, actual_start_ms: 1000, actual_end_ms: 5980, duration_ms: 4980, object_key: key, sha256: sha256Hex(bytes), bytes: bytes.length, width: 1280, height: 720 } }, 2);
  const view = JobView.parse((await request(`/v1/jobs/${quote.job_id}`, token)).body);
  assert.equal(view.used.clip_ms, 4980);
  assert.equal(view.reserved.clip_ms, 0);
  assert.equal(view.remaining.clip_ms, 10020);
});

test("an empty eventually-consistent Stripe search cannot clear an uncertain payment", async () => {
  const token = await client();
  const quote = await quoted(token);
  charge = async () => { throw new Error("simulated timeout with unknown submission outcome"); };
  await request(`/v1/jobs/${quote.job_id}/purchase`, token, { quote_id: quote.quote_id }, { authorization: "Payment test-uncertain" });
  await ctx.sql`update payment_attempts set updated_at = now() - interval '2 minutes' where job_id = ${quote.job_id}::uuid`;
  const tick = await request("/internal/tick", undefined, {}, { authorization: `Bearer ${ctx.cfg.internalTickToken}` });
  assert.equal(tick.response.status, 200, JSON.stringify(tick.body));
  assert.equal(tick.body.payments.checked, 1);
  assert.equal(tick.body.payments.failed, 0);
  assert.equal((await request(`/v1/jobs/${quote.job_id}`, token)).body.payment_state, "reconciling");
});

test("retrieved Stripe terms must match before any entitlement or index work is granted", async () => {
  const token = await client();
  const quote = await quoted(token);
  const normalCharge = charge;
  charge = async (r, b) => {
    const outcome = await normalCharge(r, b);
    if (outcome.status === 200) intents.get(outcome.reference)!.amount = 49;
    return outcome;
  };
  const purchase = await request(`/v1/jobs/${quote.job_id}/purchase`, token, { quote_id: quote.quote_id }, { authorization: "Payment mismatched-intent" });
  assert.equal(purchase.response.status, 202);
  const view = JobView.parse((await request(`/v1/jobs/${quote.job_id}`, token)).body);
  assert.equal(view.payment_state, "reconciling");
  assert.equal(view.paid_at, null);
  assert.equal(view.operations.length, 0);
  const pi = [...intents.values()][0]!;
  const raw = JSON.stringify({ id: "evt_mismatched_terms", object: "event", type: "payment_intent.succeeded", data: { object: pi } });
  const response = await app.request(`${ORIGIN}/webhooks/stripe`, { method: "POST", headers: { "stripe-signature": Stripe.webhooks.generateTestHeaderString({ payload: raw, secret: STRIPE_SECRET }) }, body: raw });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as any).applied, false);
  assert.equal(Number((await ctx.sql`select count(*) as n from operations where kind = 'index_video'`)[0]!.n), 0);
});

for (const kind of ["frames", "clips"] as const) {
  test(`concurrent equivalent ${kind} with distinct request IDs charge the unique artifact once`, async () => {
    const token = await client();
    const quote = await indexed(token);
    const path = `/v1/jobs/${quote.job_id}/${kind}`;
    const input = kind === "frames" ? { timestamps_ms: [2000] } : { start_ms: 2000, end_ms: 4000 };
    const requests = await Promise.all(Array.from({ length: 2 }, () => request(path, token, { ...input, request_id: randomUUID() })));
    assert.ok(requests.every((r) => r.response.status === 202));
    assert.notEqual(requests[0]!.body.operation_id, requests[1]!.body.operation_id);
    await Promise.all(requests.map((r) => dispatchAndLaunch(r.body.operation_id)));
    await Promise.all(requests.map((r) => {
      const opId = r.body.operation_id;
      const objectKey = `${quote.video_id}/ops/${opId}/g1/output.${kind === "frames" ? "jpg" : "mp4"}`;
      const bytes = Buffer.from(`encoded-${kind}`);
      objects.set(objectKey, bytes);
      const common = { object_key: objectKey, sha256: sha256Hex(bytes), bytes: bytes.length, width: 1280, height: 720 };
      return result(opId, kind === "frames"
        ? { frames: [{ requested_ms: 2000, actual_ms: 2000, ...common }] }
        : { clip: { requested_start_ms: 2000, requested_end_ms: 4000, actual_start_ms: 2000, actual_end_ms: 4000, duration_ms: 2000, ...common } });
    }));
    const view = JobView.parse((await request(`/v1/jobs/${quote.job_id}`, token)).body);
    assert.equal(kind === "frames" ? view.used.frames : view.used.clip_ms, kind === "frames" ? 1 : 2000);
    assert.equal(kind === "frames" ? view.reserved.frames : view.reserved.clip_ms, 0);
    const refs = await Promise.all(requests.map((r) => request(`/v1/jobs/${quote.job_id}/operations/${r.body.operation_id}`, token)));
    assert.ok(refs.every((r) => r.body.state === "succeeded"));
    assert.equal(refs[0]!.body.result.artifacts[0].artifact_id, refs[1]!.body.result.artifacts[0].artifact_id);
  });
}

test("worker preflight rejection accepts null media metadata and becomes a terminal video rejection", async () => {
  const token = await client();
  const { videoId } = await upload(token);
  const completed = await request(`/v1/videos/${videoId}/complete`, token, {});
  const opId = completed.body.operation_id;
  await dispatchAndLaunch(opId);
  await result(opId, { accepted: false, sha256: null, size_bytes: null, duration_ms: null, width: null, height: null, rotation: null, audio: null, reject_code: "MEDIA_UNSUPPORTED", reject_message: "Container has no video stream." });
  const video = await request(`/v1/videos/${videoId}`, token);
  assert.equal(video.body.state, "rejected");
  assert.equal(video.body.reject.message, "Container has no video stream.");
  const [op] = await ctx.sql`select state, generation from operations where id = ${opId}::uuid`;
  assert.equal(op!.state, "succeeded", "probe succeeded in determining that input is rejected");
  assert.equal(op!.generation, 1, "unsupported input must not trigger a worker retry");
});
