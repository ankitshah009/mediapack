import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, type JobView } from "../api/client.ts";
import {
  demoAgentOffered, demoFailureLocksPayment, describeDemoPayFailure, readDemoPayAttempt, writeDemoPayAttempt,
  type DemoPayFailure,
} from "./demoPay.ts";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const me = { authenticated: true, demo_buyer: true };
const job: Pick<JobView, "job_id" | "payment_state" | "state" | "quote"> = {
  job_id: "job-1", payment_state: "unpaid", state: "awaiting_payment",
  quote: {
    schema_version: "mediapack.v1", quote_id: "quote-1", job_id: "job-1", video_id: "video-1",
    source_sha256: "a".repeat(64), amount_minor: 50, currency: "usd", payment_mode: "test",
    expires_at: new Date(NOW + 60_000).toISOString(), pack_ttl_seconds: 86400,
    limits: { searches: 3, frames: 8, clip_ms: 15000, text_chars: 8000 },
    indexer_version: "index-v1", terms_hash: "b".repeat(64), purchase_url: "https://example.test/v1/jobs/job-1/purchase",
  },
};
const fail = (status: number, code: string, extra: Partial<ApiError> = {}) =>
  describeDemoPayFailure(new ApiError(status, code, "server message", extra));
const hintOf = (f: DemoPayFailure) => (f.kind === "expired" ? "" : f.hint);

function store() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

test("the demo agent requires server capability, an authenticated owner and the exact open test quote", () => {
  assert.equal(demoAgentOffered(me, job, NOW), true);
  for (const probe of [undefined, { authenticated: true }, { authenticated: true, demo_buyer: false }, { authenticated: false, demo_buyer: true }]) {
    assert.equal(demoAgentOffered(probe, job, NOW), false);
  }
  for (const quote of [
    { ...job.quote, payment_mode: "live" as const }, { ...job.quote, amount_minor: 100 },
    { ...job.quote, currency: "eur" }, { ...job.quote, job_id: "other-job" },
    { ...job.quote, expires_at: new Date(NOW).toISOString() }, { ...job.quote, expires_at: "invalid" },
  ]) assert.equal(demoAgentOffered(me, { ...job, quote }, NOW), false);
  for (const payment_state of ["paid", "reconciling"] as const) {
    assert.equal(demoAgentOffered(me, { ...job, payment_state }, NOW), false);
  }
  assert.equal(demoAgentOffered(me, { ...job, state: "failed" }, NOW), false);
});

test("only safe pre-reservation refusals unlock the quote and retain own-agent payment guidance", () => {
  const safe = [
    [429, "ALLOWANCE_EXCEEDED", "limit"], [404, "NOT_FOUND", "unavailable"],
    [401, "UNAUTHORIZED", "session"], [403, "UNAUTHORIZED", "session"],
    [400, "BAD_REQUEST", "invalid"], [410, "QUOTE_EXPIRED", "expired"],
  ] as const;
  for (const [status, code, kind] of safe) {
    const failure = fail(status, code);
    assert.equal(failure.kind, kind);
    assert.equal(demoFailureLocksPayment(failure), false);
  }
  assert.match(hintOf(fail(429, "ALLOWANCE_EXCEEDED")), /commands below/);
  assert.equal(demoFailureLocksPayment(fail(409, "ALLOWANCE_EXCEEDED")), true, "a pack/payment conflict is not the upfront daily cap");
});

test("a durable prior reservation never offers a second payment, even while merchant state is still unpaid", () => {
  const failure = fail(409, "PAYMENT_RECONCILING", { retryable: false });
  assert.equal(failure.kind, "pending");
  assert.equal(demoFailureLocksPayment(failure), true);
  assert.match(hintOf(failure), /Do not pay this quote again/);
  assert.match(hintOf(failure), /operator/);
});

test("network failures and every server 5xx keep the outcome unknown regardless of JSON or retryable flags", () => {
  for (const error of [fail(0, "NETWORK", { retryable: true }), ...[500, 502, 503, 504].flatMap((status) => [
    fail(status, "INTERNAL", { retryable: true }), fail(status, "INTERNAL", { unstructured: true }),
  ])]) {
    assert.equal(error.kind, "unknown");
    assert.equal(demoFailureLocksPayment(error), true);
    assert.match(hintOf(error), /Do not pay this quote again/);
    assert.doesNotMatch(hintOf(error), /try again/i);
  }
});

test("a declined demo payment has still consumed its durable quote reservation", () => {
  const failure = fail(402, "PAYMENT_REQUIRED", { retryable: false });
  assert.equal(failure.kind, "failed");
  assert.equal(demoFailureLocksPayment(failure), true);
  assert.doesNotMatch(hintOf(failure), /nothing.*charged|try again/i);
  assert.match(hintOf(failure), /operator/);
});

test("the quote marker survives a re-read and keeps other quotes independent", () => {
  const storage = store();
  assert.equal(readDemoPayAttempt(storage, "quote-1"), "idle");
  writeDemoPayAttempt(storage, "quote-1", "submitted");
  assert.equal(readDemoPayAttempt({ ...storage }, "quote-1"), "submitted", "a reload/new subscriber reads the existing attempt");
  writeDemoPayAttempt(storage, "quote-1", "unknown");
  assert.equal(readDemoPayAttempt(storage, "quote-1"), "unknown");
  assert.equal(readDemoPayAttempt(storage, "quote-2"), "idle");
  writeDemoPayAttempt(storage, "quote-1", "blocked");
  assert.equal(readDemoPayAttempt(storage, "quote-1"), "blocked");
  writeDemoPayAttempt(storage, "quote-2", "submitted");
  writeDemoPayAttempt(storage, "quote-2", "idle");
  assert.equal(readDemoPayAttempt(storage, "quote-2"), "idle", "a safe upfront refusal may release its browser marker");
  assert.equal(readDemoPayAttempt(storage, "quote-1"), "blocked");
});

test("an unrecognized saved marker fails closed instead of silently offering another payment", () => {
  const storage = store();
  storage.setItem("mp:demo-pay:quote-1", "interrupted-or-newer-version");
  assert.equal(readDemoPayAttempt(storage, "quote-1"), "unknown");
});

test("a browser that silently drops writes cannot start a payment without a durable browser marker", () => {
  const storage = { ...store(), setItem: () => {} };
  assert.throws(() => writeDemoPayAttempt(storage, "quote-1", "submitted"), /could not be saved/);
  const failure = fail(0, "LOCAL_STATE_UNAVAILABLE");
  assert.equal(failure.kind, "storage");
  assert.equal(demoFailureLocksPayment(failure), false);
  assert.match(hintOf(failure), /No demo request was sent/);
});
