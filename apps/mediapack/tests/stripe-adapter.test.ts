import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { Challenge, Credential } from "mppx";
import { createStripeAdapter, type ChargeBinding } from "../src/adapters/stripe.js";
import { parseConfig } from "../src/config.js";

const submissions: URLSearchParams[] = [];
const stripe = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (req.method !== "POST" || req.url !== "/v1/payment_intents") {
    res.writeHead(404).end();
    return;
  }
  submissions.push(new URLSearchParams(body));
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
    id: "pi_local_adapter_test", object: "payment_intent", status: "succeeded", amount: 50, currency: "usd", livemode: false,
  }));
});
let adapter: ReturnType<typeof createStripeAdapter>;
before(async () => {
  await new Promise<void>((resolve, reject) => { stripe.once("error", reject); stripe.listen(0, "127.0.0.1", resolve); });
  const port = (stripe.address() as { port: number }).port;
  adapter = createStripeAdapter(parseConfig({
    STRIPE_SECRET_KEY: "sk_test_local_adapter_only", STRIPE_PROFILE_ID: "profile_test_local_adapter_only",
    MPP_SECRET_KEY: "local-adapter-signing-secret-at-least-32-characters", STRIPE_API_BASE: `http://127.0.0.1:${port}`,
  }));
});
after(async () => { if (stripe.listening) await new Promise<void>((resolve) => stripe.close(() => resolve())); });

const binding: ChargeBinding = {
  amountMinor: 50, currency: "usd", quoteId: "quote-local", jobId: "job-local", termsHash: "local-terms-hash",
  route: "POST /v1/jobs/job-local/purchase",
  intentMetadata: () => ({ job_id: "job-local", quote_id: "quote-local", terms_hash: "local-terms-hash", attempt_id: "attempt-local" }),
};
const request = (authorization?: string) => new Request("http://localhost:3000/v1/jobs/job-local/purchase", {
  method: "POST", headers: authorization ? { authorization } : {}, body: JSON.stringify({ quote_id: binding.quoteId }),
});

test("real mppx challenge and Stripe SDK preserve quoted amount, binding and receipt", async () => {
  const challengeResult = await adapter.charge(request(), binding);
  assert.equal(challengeResult.status, 402);
  if (challengeResult.status !== 402) return;
  assert.equal(challengeResult.reachedStripe, false);
  const challenge = Challenge.fromResponse(challengeResult.response);
  assert.equal(challenge.method, "stripe");
  assert.equal(challenge.request.amount, "50");
  assert.equal(challenge.request.externalId, binding.quoteId);
  const auth = Credential.serialize(Credential.from({ challenge, payload: { spt: "spt_local_test", externalId: binding.quoteId } }));
  const paid = await adapter.charge(request(auth), binding);
  assert.equal(paid.status, 200);
  if (paid.status !== 200) return;
  assert.equal(paid.reference, "pi_local_adapter_test");
  assert.ok(paid.receiptHeader);
  const form = submissions.at(-1)!;
  assert.equal(form.get("amount"), "50");
  assert.equal(form.get("currency"), "usd");
  assert.equal(form.get("shared_payment_granted_token"), "spt_local_test");
  for (const [k, v] of Object.entries(binding.intentMetadata!())) assert.equal(form.get(`metadata[${k}]`), v);
});

test("a credential from another quote is refused before a Stripe submission", async () => {
  const issued = await adapter.charge(request(), binding);
  assert.equal(issued.status, 402);
  if (issued.status !== 402) return;
  const challenge = Challenge.fromResponse(issued.response);
  const auth = Credential.serialize(Credential.from({ challenge, payload: { spt: "spt_local_wrong_quote", externalId: binding.quoteId } }));
  const count = submissions.length;
  const result = await adapter.charge(request(auth), { ...binding, quoteId: "quote-other" });
  assert.equal(result.status, 402);
  assert.equal(submissions.length, count);
});
