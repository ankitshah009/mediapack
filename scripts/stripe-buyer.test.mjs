import test from 'node:test';
import assert from 'node:assert/strict';
import { createSandboxTokenIssuer } from './stripe-buyer.mjs';

const quote = { payment_mode: 'test', amount_minor: 50, currency: 'usd', quote_id: '00000000-0000-4000-8000-000000000003' };
const request = { amount: '50', currency: 'usd', networkId: 'profile_test_buyer', expiresAt: 1_900_000_000,
  challenge: { id: 'unchanged-hmac-challenge', request: { externalId: quote.quote_id } } };
const KEY = 'sk_test_fixture_only';
const success = () => Response.json({ id: 'spt_fixture_only' });
function issuer(responses, overrides = {}) {
  const calls = [];
  const create = createSandboxTokenIssuer({ quote, key: KEY, ...overrides, fetchImpl: async (url, init) => {
    calls.push({ url, ...init, body: new URLSearchParams(init.body) });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    assert.ok(next, 'unexpected token helper request');
    return next;
  } });
  return { create, calls };
}

test('public test profile path issues one test-helper token and preserves challenge binding', async () => {
  const { create, calls } = issuer([success()]);
  const before = JSON.stringify(request.challenge);
  assert.equal(await create(request), 'spt_fixture_only');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.stripe.com/v1/test_helpers/shared_payment/granted_tokens');
  assert.equal(calls[0].body.get('seller_details[network_id]'), request.networkId);
  assert.equal(calls[0].body.get('usage_limits[max_amount]'), '50');
  assert.equal(calls[0].redirect, 'error');
  assert.equal(JSON.stringify(request.challenge), before);
  await assert.rejects(create(request), /already attempted/);
  assert.equal(calls.length, 1, 'repeated invocation cannot issue another token');
});

test('internal challenge needs the explicit buyer-side internal opt-in', async () => {
  const blocked = issuer([]);
  await assert.rejects(blocked.create({ ...request, networkId: 'internal' }), /does not match/);
  assert.equal(blocked.calls.length, 0);
  const allowed = issuer([success()], { testNetworkId: 'internal' });
  assert.equal(await allowed.create({ ...request, networkId: 'internal' }), 'spt_fixture_only');
  assert.equal(allowed.calls[0].body.get('seller_details[network_id]'), 'internal');
});

test('quote, currency, amount, external ID, network and key mismatches fail before I/O', async () => {
  for (const changed of [{ payment_mode: 'live' }, { amount_minor: 51 }, { currency: 'eur' }, { quote_id: '' }]) {
    assert.throws(() => issuer([], { quote: { ...quote, ...changed } }), /only authorizes/);
  }
  for (const key of ['sk_live_fixture', 'not-a-key', undefined]) assert.throws(() => issuer([], { key }), /sandbox key/);
  for (const network of ['other', 'profile_live_fixture', 'INTERNAL']) assert.throws(() => issuer([], { testNetworkId: network }), /only supports/);
  for (const changed of [{ amount: '51' }, { currency: 'eur' }, { networkId: 'profile_live_fixture' }, { networkId: 'other' }, { challenge: { request: { externalId: 'another-quote' } } }]) {
    const blocked = issuer([], { testNetworkId: 'internal' });
    await assert.rejects(blocked.create({ ...request, ...changed }), /does not match/);
    assert.equal(blocked.calls.length, 0);
  }
});

test('definitive unsupported optional test-helper parameter permits exactly one reduced request', async () => {
  for (const param of ['seller_details', 'seller_details[network_id]', 'metadata', 'metadata[job_id]']) {
    const first = Response.json({ error: { code: 'parameter_unknown', param } }, { status: 400 });
    const { create, calls } = issuer([first, success()], { testNetworkId: 'internal' });
    assert.equal(await create({ ...request, networkId: 'internal', metadata: { job_id: 'job-fixture' } }), 'spt_fixture_only');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.get('metadata[job_id]'), 'job-fixture');
    assert(![...calls[1].body.keys()].some(k => k.startsWith('seller_details') || k.startsWith('metadata')));
    for (const name of ['payment_method', 'usage_limits[currency]', 'usage_limits[max_amount]', 'usage_limits[expires_at]']) {
      assert.equal(calls[1].body.get(name), calls[0].body.get(name));
    }
    assert.equal(calls[1].url, calls[0].url);
  }
});

test('timeouts and nondefinitive errors never trigger compatibility issuance', async () => {
  const cases = [new DOMException('fixture timeout', 'TimeoutError'),
    Response.json({ error: { code: 'parameter_unknown', param: 'seller_details' } }, { status: 500 }),
    Response.json({ error: { code: 'parameter_unknown', param: 'seller_details' } }, { status: 429 }),
    Response.json({ error: { code: 'card_declined', param: 'seller_details' } }, { status: 400 }),
    Response.json({ error: { code: 'parameter_unknown', param: 'payment_method' } }, { status: 400 }),
    Response.json({ error: { code: 'parameter_unknown' } }, { status: 400 }),
    new Response('not-json', { status: 400 })];
  for (const response of cases) {
    const { create, calls } = issuer([response]);
    await assert.rejects(create(request), /No automatic retry/);
    assert.equal(calls.length, 1);
    await assert.rejects(create(request), /already attempted/);
    assert.equal(calls.length, 1);
  }
});

test('failed compatibility request is final and never logs provider error or credentials', async () => {
  const { create, calls } = issuer([
    Response.json({ error: { code: 'parameter_unknown', param: 'seller_details' } }, { status: 400 }),
    Response.json({ error: { code: 'parameter_unknown', param: 'metadata', message: `${KEY} provider-private-detail` } }, { status: 400 }),
  ]);
  await assert.rejects(create(request), error => {
    assert.match(error.message, /HTTP 400/);
    assert(!error.message.includes(KEY));
    assert(!error.message.includes('provider-private-detail'));
    return true;
  });
  assert.equal(calls.length, 2);
});
