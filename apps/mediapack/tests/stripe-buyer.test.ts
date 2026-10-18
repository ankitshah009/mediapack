import assert from "node:assert/strict";
import { test } from "node:test";
import { createSandboxTokenIssuer, SandboxTokenError, type SandboxTokenIssuerOptions, type TokenRequest } from "../src/adapters/stripe-buyer.js";

// Mirrors scripts/stripe-buyer.test.mjs: the server's issuer is a port of the CLI buyer's and must reject the same inputs.
const quote = { payment_mode: "test", amount_minor: 50, currency: "usd", quote_id: "00000000-0000-4000-8000-000000000003" };
const request: TokenRequest = {
  amount: "50", currency: "usd", networkId: "internal", expiresAt: 1_900_000_000,
  challenge: { request: { externalId: quote.quote_id } },
};
const KEY = "sk_test_fixture_only";
const HELPER_URL = "https://api.stripe.com/v1/test_helpers/shared_payment/granted_tokens";
const success = () => Response.json({ id: "spt_fixture_only" });

interface Call { url: string; init: RequestInit; body: URLSearchParams }
function issuer(responses: Array<Response | Error>, overrides: Partial<SandboxTokenIssuerOptions> = {}) {
  const calls: Call[] = [];
  const create = createSandboxTokenIssuer({
    quote, key: KEY, testNetworkId: "internal", ...overrides,
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, init, body: new URLSearchParams(init.body as URLSearchParams) });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      assert.ok(next, "unexpected token helper request");
      return next;
    }) as typeof fetch,
  });
  return { create, calls };
}

test("a matching challenge posts the exact test-helper request once and returns the token id", async () => {
  const { create, calls } = issuer([success()]);
  const challenge = JSON.stringify(request.challenge);
  assert.equal(await create(request), "spt_fixture_only");
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, HELPER_URL);
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.redirect, "error");
  assert.ok(call.init.signal instanceof AbortSignal, "every Stripe call carries a timeout");
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers.authorization, `Basic ${Buffer.from(`${KEY}:`).toString("base64")}`);
  assert.equal(headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(headers["Stripe-Version"], "2026-07-29.preview");
  assert.deepEqual(Object.fromEntries(call.body), {
    payment_method: "pm_card_visa", "usage_limits[currency]": "usd", "usage_limits[max_amount]": "50",
    "usage_limits[expires_at]": "1900000000", "seller_details[network_id]": "internal",
  });
  assert.equal(JSON.stringify(request.challenge), challenge, "the signed challenge is never modified");
});

test("challenge metadata is forwarded and a public test profile network needs no internal opt-in", async () => {
  const { create, calls } = issuer([success()], { testNetworkId: undefined });
  assert.equal(await create({ ...request, networkId: "profile_test_buyer", metadata: { job_id: "job-fixture" } }), "spt_fixture_only");
  assert.equal(calls[0]!.body.get("seller_details[network_id]"), "profile_test_buyer");
  assert.equal(calls[0]!.body.get("metadata[job_id]"), "job-fixture");
});

test("a second call is refused without another Stripe request", async () => {
  const { create, calls } = issuer([success()]);
  await create(request);
  await assert.rejects(create(request), /already attempted/);
  assert.equal(calls.length, 1, "repeated invocation cannot issue another token");
});

test("a challenge that differs in amount, currency, network or external id throws before any Stripe call", async () => {
  const mismatches: Array<[string, Partial<TokenRequest>]> = [
    ["amount", { amount: "51" }],
    ["currency", { currency: "eur" }],
    ["live profile network", { networkId: "profile_live_fixture" }],
    ["unknown network", { networkId: "other" }],
    ["missing network", { networkId: undefined }],
    ["external id", { challenge: { request: { externalId: "another-quote" } } }],
    ["missing external id", { challenge: { request: {} } }],
  ];
  for (const [name, changed] of mismatches) {
    const blocked = issuer([]);
    await assert.rejects(blocked.create({ ...request, ...changed }), /does not match/, name);
    assert.equal(blocked.calls.length, 0, name);
  }
});

test("the internal network needs the explicit buyer-side opt-in", async () => {
  const blocked = issuer([], { testNetworkId: undefined });
  await assert.rejects(blocked.create(request), /does not match/);
  assert.equal(blocked.calls.length, 0);
});

test("quote, key and network misconfiguration fail at construction, before any I/O", () => {
  for (const changed of [{ payment_mode: "live" }, { amount_minor: 51 }, { currency: "eur" }, { quote_id: "" }]) {
    assert.throws(() => issuer([], { quote: { ...quote, ...changed } }), /only authorizes/);
  }
  for (const key of ["sk_live_fixture", "rk_live_fixture", "not-a-key", "", undefined]) {
    assert.throws(() => issuer([], { key }), (error) => error instanceof SandboxTokenError && /sandbox key/.test(error.message), String(key));
  }
  assert.doesNotThrow(() => issuer([], { key: "rk_test_restricted_fixture" }));
  for (const network of ["other", "profile_live_fixture", "INTERNAL"]) assert.throws(() => issuer([], { testNetworkId: network }), /only supports/);
});

test("a definitive unsupported optional test-helper parameter permits exactly one reduced request", async () => {
  for (const param of ["seller_details", "seller_details[network_id]", "metadata", "metadata[job_id]"]) {
    const first = Response.json({ error: { code: "parameter_unknown", param } }, { status: 400 });
    const { create, calls } = issuer([first, success()]);
    assert.equal(await create({ ...request, metadata: { job_id: "job-fixture" } }), "spt_fixture_only");
    assert.equal(calls.length, 2, param);
    assert.equal(calls[0]!.body.get("metadata[job_id]"), "job-fixture");
    assert.ok(![...calls[1]!.body.keys()].some((k) => k.startsWith("seller_details") || k.startsWith("metadata")), param);
    for (const name of ["payment_method", "usage_limits[currency]", "usage_limits[max_amount]", "usage_limits[expires_at]"]) {
      assert.equal(calls[1]!.body.get(name), calls[0]!.body.get(name), name);
    }
    assert.equal(calls[1]!.url, calls[0]!.url);
  }
});

test("timeouts and nondefinitive errors never trigger compatibility issuance", async () => {
  const cases: Array<Response | Error> = [
    new DOMException("fixture timeout", "TimeoutError"),
    Response.json({ error: { code: "parameter_unknown", param: "seller_details" } }, { status: 500 }),
    Response.json({ error: { code: "parameter_unknown", param: "seller_details" } }, { status: 429 }),
    Response.json({ error: { code: "card_declined", param: "seller_details" } }, { status: 400 }),
    Response.json({ error: { code: "parameter_unknown", param: "payment_method" } }, { status: 400 }),
    Response.json({ error: { code: "parameter_unknown" } }, { status: 400 }),
    new Response("not-json", { status: 400 }),
  ];
  for (const response of cases) {
    const { create, calls } = issuer([response]);
    await assert.rejects(create(request), /No automatic retry/);
    assert.equal(calls.length, 1);
    await assert.rejects(create(request), /already attempted/);
    assert.equal(calls.length, 1);
  }
});

test("failure classes tell the caller whether trying again can help, and never expose provider text or the key", async () => {
  const outcomes: Array<[Response | Error, { transient: boolean; httpStatus?: number }]> = [
    [new DOMException("fixture timeout", "TimeoutError"), { transient: true }],
    [Response.json({}, { status: 503 }), { transient: true, httpStatus: 503 }],
    [Response.json({}, { status: 429 }), { transient: true, httpStatus: 429 }],
    [Response.json({ error: { message: `${KEY} provider-private-detail` } }, { status: 401 }), { transient: false, httpStatus: 401 }],
    [new Response("not-json", { status: 200 }), { transient: true }],
    [Response.json({ object: "shared_payment.granted_token" }), { transient: true }],
    [Response.json(null), { transient: true }],
  ];
  for (const [response, expected] of outcomes) {
    const { create } = issuer([response]);
    await assert.rejects(create(request), (error) => {
      assert.ok(error instanceof SandboxTokenError);
      assert.equal(error.transient, expected.transient);
      assert.equal(error.httpStatus, expected.httpStatus);
      assert.ok(!error.message.includes(KEY));
      assert.ok(!error.message.includes("provider-private-detail"));
      return true;
    });
  }
});

test("a failed compatibility request is final and never logs provider error or credentials", async () => {
  const { create, calls } = issuer([
    Response.json({ error: { code: "parameter_unknown", param: "seller_details" } }, { status: 400 }),
    Response.json({ error: { code: "parameter_unknown", param: "metadata", message: `${KEY} provider-private-detail` } }, { status: 400 }),
  ]);
  await assert.rejects(create(request), (error: Error) => {
    assert.match(error.message, /HTTP 400/);
    assert.ok(!error.message.includes(KEY));
    assert.ok(!error.message.includes("provider-private-detail"));
    return true;
  });
  assert.equal(calls.length, 2);
});

test("the test-harness API base redirects the helper request and nothing else changes", async () => {
  const { create, calls } = issuer([success()], { apiBase: "http://127.0.0.1:4010" });
  await create(request);
  assert.equal(calls[0]!.url, "http://127.0.0.1:4010/v1/test_helpers/shared_payment/granted_tokens");
});
