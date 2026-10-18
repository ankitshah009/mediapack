import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { setupStripe, SetupError } from './setup-stripe.mjs';

const KEY = 'rk_test_private123';
const SECRET = 'whsec_privateWebhook';
const PROFILE = 'profile_test_private123';
const ACCOUNT = 'acct_private123';
const ORIGIN = 'https://app.example.test';
const OWNER = 'mediapack-stripe-setup-v1';
const endpoint = overrides => ({ id: 'we_owned123', livemode: false, url: `${ORIGIN}/webhooks/stripe`, status: 'enabled',
  metadata: { mediapack_setup: OWNER }, enabled_events: ['payment_intent.succeeded'], ...overrides });
async function fixture(t, { env = `# preserved\nDATABASE_URL=privateDatabase\nSTRIPE_SECRET_KEY=${KEY}\n`,
  endpoints = [], profile = { id: PROFILE }, account = { id: ACCOUNT }, response, mutateEnv } = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), 'mediapack-stripe-test-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await mkdir(join(rootDir, 'apps/web'), { recursive: true });
  await mkdir(join(rootDir, '.blaxel'));
  const envPath = join(rootDir, 'apps/web/.env.blaxel');
  await writeFile(envPath, env, { mode: 0o644 });
  await writeFile(join(rootDir, '.blaxel/web-host.json'), JSON.stringify({ origin: ORIGIN }));
  const calls = [], cloud = { endpoints: structuredClone(endpoints), creates: 0 };
  const fetchImpl = async (url, init) => {
    const u = new URL(url), fields = new URLSearchParams(init.body);
    assert.equal(u.origin, 'https://api.stripe.com');
    assert.equal(init.headers.authorization, `Bearer ${KEY}`);
    assert.equal(init.headers['Stripe-Version'], '2026-07-29.preview');
    assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
    calls.push({ url, ...init, fields });
    if (response) { const result = await response(u, init); if (result) return result; }
    if (u.pathname === '/v1/account') return Response.json(account);
    if (u.pathname === '/v2/network/business_profiles/me') return Response.json(profile);
    if (u.pathname === '/v1/webhook_endpoints' && init.method === 'GET') {
      if (mutateEnv) await writeFile(envPath, `${env}NEW_SETTING=changed\n`);
      return Response.json({ data: cloud.endpoints, has_more: false });
    }
    if (u.pathname === '/v1/webhook_endpoints' && init.method === 'POST') {
      cloud.creates++;
      const created = endpoint({ url: fields.get('url'), secret: SECRET });
      cloud.endpoints.push(created); return Response.json(created);
    }
    if (u.pathname === '/v1/webhook_endpoints/we_owned123' && init.method === 'POST') {
      const updated = endpoint({ url: fields.get('url') }); cloud.endpoints = [updated]; return Response.json(updated);
    }
    assert.fail(`Unexpected Stripe operation ${init.method} ${u.pathname}`);
  };
  return { rootDir, envPath, env, calls, cloud, options: { rootDir, fetchImpl } };
}
const rejects = (f, code, extra = {}) => assert.rejects(setupStripe({ ...f.options, ...extra }), error => error instanceof SetupError && error.code === code);

test('plan reads only account/profile/webhooks and never returns identities or secrets', async t => {
  const f = await fixture(t);
  const result = await setupStripe(f.options);
  assert.equal(result.webhook_action, 'create_owned_test_endpoint');
  assert.equal(result.mode, 'plan');
  assert.equal(f.calls.length, 3); assert.ok(f.calls.every(c => c.method === 'GET'));
  assert.equal(await readFile(f.envPath, 'utf8'), f.env);
  for (const value of [KEY, SECRET, PROFILE, ACCOUNT, ORIGIN, 'privateDatabase']) assert.ok(!JSON.stringify(result).includes(value));
});

test('apply creates only owned test webhook and saves private settings while preserving other integrations', async t => {
  const f = await fixture(t);
  const result = await setupStripe({ ...f.options, apply: true });
  assert.equal(result.payment_attempted, false); assert.equal(result.settings_saved, true);
  const env = parseEnv(await readFile(f.envPath, 'utf8'));
  assert.equal(env.STRIPE_SECRET_KEY, KEY); assert.equal(env.DATABASE_URL, 'privateDatabase');
  assert.equal(env.PAYMENTS_MODE, 'test'); assert.equal(env.STRIPE_PROFILE_ID, PROFILE); assert.equal(env.STRIPE_WEBHOOK_SECRET, SECRET);
  assert.equal((await stat(f.envPath)).mode & 0o777, 0o600);
  const path = join(f.rootDir, '.blaxel/stripe-setup.json');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const saved = await readFile(path, 'utf8'); assert.ok(!saved.includes(KEY)); assert.ok(!saved.includes(SECRET));
  const create = f.calls.find(c => c.method === 'POST');
  assert.equal(create.fields.get('enabled_events[0]'), 'payment_intent.succeeded');
  assert.equal(create.fields.get('metadata[mediapack_setup]'), OWNER);
  assert.ok(create.headers['Idempotency-Key']);
});

test('repeat apply reuses owned endpoint without recreating or changing it', async t => {
  const f = await fixture(t);
  await setupStripe({ ...f.options, apply: true });
  const result = await setupStripe({ ...f.options, apply: true });
  assert.equal(result.webhook_action, 'reuse_owned_test_endpoint'); assert.equal(f.cloud.creates, 1);
});

test('existing app-owned endpoint URL updates preserve its known signing secret', async t => {
  const f = await fixture(t, { env: `STRIPE_SECRET_KEY=${KEY}\nSTRIPE_WEBHOOK_SECRET=${SECRET}\n`, endpoints: [endpoint({ url: 'https://old.example.test/webhooks/stripe' })] });
  const result = await setupStripe({ ...f.options, apply: true });
  assert.equal(result.webhook_action, 'update_owned_test_endpoint');
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  assert.equal(parseEnv(await readFile(f.envPath, 'utf8')).STRIPE_WEBHOOK_SECRET, SECRET);
});

test('unrelated endpoints are never updated or deleted', async t => {
  const f = await fixture(t, { endpoints: [endpoint({ id: 'we_other', metadata: {}, url: 'https://other.example.test/' })] });
  await setupStripe({ ...f.options, apply: true });
  assert.ok(f.calls.filter(c => c.method !== 'GET').every(c => new URL(c.url).pathname === '/v1/webhook_endpoints' && c.method === 'POST'));
});

test('live key is refused before any provider call', async t => {
  const f = await fixture(t, { env: 'STRIPE_SECRET_KEY=sk_live_private\n' });
  await rejects(f, 'test_key_required', { apply: true }); assert.equal(f.calls.length, 0);
});

test('live payments mode is refused before any provider call', async t => {
  const f = await fixture(t, { env: `STRIPE_SECRET_KEY=${KEY}\nPAYMENTS_MODE=live\n` });
  await rejects(f, 'live_mode_refused'); assert.equal(f.calls.length, 0);
});

test('missing persistent key does not fall back to local CLI OAuth', async t => {
  const f = await fixture(t, { env: '' }); await rejects(f, 'persistent_key_required'); assert.equal(f.calls.length, 0);
});

test('non-test profile in env and provider response are refused', async t => {
  const f = await fixture(t, { env: `STRIPE_SECRET_KEY=${KEY}\nSTRIPE_PROFILE_ID=profile_live\n` });
  await rejects(f, 'test_profile_required'); assert.equal(f.calls.length, 0);
  const g = await fixture(t, { profile: { id: 'profile_live' } }); await rejects(g, 'invalid_api_response');
});

test('mismatched configured test profile is refused', async t => {
  const f = await fixture(t, { env: `STRIPE_SECRET_KEY=${KEY}\nSTRIPE_PROFILE_ID=profile_test_other\n` });
  await rejects(f, 'profile_mismatch', { apply: true }); assert.ok(f.calls.every(c => c.method === 'GET'));
});

test('missing profile produces actionable Dashboard setup with no provider payload', async t => {
  const f = await fixture(t, { response: u => u.pathname.includes('business_profiles') ? Response.json({ error: KEY }, { status: 404 }) : undefined });
  await rejects(f, 'sandbox_profile_required'); assert.ok(f.calls.every(c => c.method === 'GET'));
});

test('owned endpoint without its signing secret is not recreated or rotated', async t => {
  const f = await fixture(t, { endpoints: [endpoint()] }); await rejects(f, 'webhook_secret_required', { apply: true });
  assert.ok(f.calls.every(c => c.method === 'GET'));
});

test('ambiguous or cross-account ownership blocks all writes', async t => {
  const f = await fixture(t, { endpoints: [endpoint(), endpoint({ id: 'we_second' })] });
  await rejects(f, 'ambiguous_endpoint', { apply: true });
  const g = await fixture(t);
  await writeFile(join(g.rootDir, '.blaxel/stripe-setup.json'), JSON.stringify({ owner: OWNER, account_id: 'acct_other' }));
  await rejects(g, 'account_mismatch', { apply: true }); assert.ok(g.calls.every(c => c.method === 'GET'));
});

test('concurrent env changes are preserved and block webhook mutation', async t => {
  const f = await fixture(t, { mutateEnv: true }); await rejects(f, 'configuration_changed', { apply: true });
  assert.ok((await readFile(f.envPath, 'utf8')).includes('NEW_SETTING=changed'));
  assert.ok(f.calls.every(c => c.method === 'GET'));
});

test('network failures and API errors do not expose provider payloads or credentials', async t => {
  const f = await fixture(t, { response: () => { throw new Error(`${KEY} private provider data`); } });
  await assert.rejects(setupStripe(f.options), error => error.code === 'stripe_unreachable' && !String(error).includes(KEY));
  const g = await fixture(t, { response: () => Response.json({ error: SECRET }, { status: 403 }) });
  await assert.rejects(setupStripe(g.options), error => error.code === 'stripe_api_error' && !String(error).includes(SECRET));
});

test('origin credentials or untrusted paths are refused before network access', async t => {
  const f = await fixture(t);
  for (const origin of ['http://app.example.test', 'https://user:secret@app.example.test', 'https://app.example.test/other']) {
    await rejects(f, 'invalid_origin', { origin });
  }
  assert.equal(f.calls.length, 0);
});

test('webhook list containing live mode data is rejected', async t => {
  const f = await fixture(t, { endpoints: [endpoint({ livemode: true })] });
  await rejects(f, 'invalid_api_response', { apply: true }); assert.ok(f.calls.every(c => c.method === 'GET'));
});

const internalEnv = `STRIPE_SECRET_KEY=${KEY}\nPAYMENTS_MODE=test\nSTRIPE_TEST_NETWORK_ID=internal\n`;
const absentProfile = u => u.pathname.includes('business_profiles') ? Response.json({ error: { code: 'not_found' } }, { status: 404 }) : undefined;

test('explicit internal test network permits read-only planning only when the profile is absent', async t => {
  const f = await fixture(t, { env: internalEnv, response: absentProfile });
  const result = await setupStripe(f.options);
  assert.equal(result.payment_identity, 'sandbox_internal');
  assert.equal(result.test_profile_verified, false);
  assert.equal(result.public_wallet_profile_required, true);
  assert.ok(f.calls.every(c => c.method === 'GET'));
  assert.equal(await readFile(f.envPath, 'utf8'), internalEnv);
});

test('internal apply saves no fictional profile and records the actual internal identity', async t => {
  const f = await fixture(t, { env: internalEnv, response: absentProfile });
  const result = await setupStripe({ ...f.options, apply: true });
  assert.equal(result.payment_identity, 'sandbox_internal'); assert.equal(result.test_profile_verified, false);
  assert.equal(result.payment_attempted, false);
  const env = parseEnv(await readFile(f.envPath, 'utf8'));
  assert.equal(env.STRIPE_PROFILE_ID, undefined); assert.equal(env.STRIPE_TEST_NETWORK_ID, 'internal');
  assert.equal(env.STRIPE_WEBHOOK_SECRET, SECRET); assert.equal(env.PAYMENTS_MODE, 'test');
  const state = JSON.parse(await readFile(join(f.rootDir, '.blaxel/stripe-setup.json'), 'utf8'));
  assert.equal(state.profile_id, null); assert.equal(state.network_id, 'internal'); assert.equal(state.livemode, false);
});

test('an actual verified profile is preferred over the explicit internal opt-in', async t => {
  const f = await fixture(t, { env: internalEnv });
  const result = await setupStripe({ ...f.options, apply: true });
  assert.equal(result.payment_identity, 'sandbox_profile'); assert.equal(result.test_profile_verified, true);
  assert.equal(result.public_wallet_profile_required, false);
  assert.equal(parseEnv(await readFile(f.envPath, 'utf8')).STRIPE_PROFILE_ID, PROFILE);
  const state = JSON.parse(await readFile(join(f.rootDir, '.blaxel/stripe-setup.json'), 'utf8'));
  assert.equal(state.profile_id, PROFILE); assert.equal(state.network_id, PROFILE);
});

test('internal opt-in never hides a missing or mismatched configured profile', async t => {
  const f = await fixture(t, { env: `${internalEnv}STRIPE_PROFILE_ID=${PROFILE}\n`, response: absentProfile });
  await rejects(f, 'sandbox_profile_required', { apply: true }); assert.ok(f.calls.every(c => c.method === 'GET'));
  const g = await fixture(t, { env: `${internalEnv}STRIPE_PROFILE_ID=profile_test_other\n` });
  await rejects(g, 'profile_mismatch', { apply: true }); assert.ok(g.calls.every(c => c.method === 'GET'));
});

test('internal opt-in never masks profile permission errors or other provider failures', async t => {
  for (const status of [400, 401, 403, 429, 500]) {
    const f = await fixture(t, { env: internalEnv, response: u => u.pathname.includes('business_profiles') ? Response.json({ error: SECRET }, { status }) : undefined });
    await rejects(f, 'stripe_api_error', { apply: true }); assert.ok(f.calls.every(c => c.method === 'GET'));
  }
});

test('internal opt-in rejects malformed successful profile responses instead of treating them as absent', async t => {
  for (const profile of [null, {}, { id: 'profile_live' }]) {
    const f = await fixture(t, { env: internalEnv, profile });
    await rejects(f, 'invalid_api_response', { apply: true }); assert.ok(f.calls.every(c => c.method === 'GET'));
  }
});

test('internal opt-in refuses live mode or live keys before network access', async t => {
  const f = await fixture(t, { env: internalEnv.replace('PAYMENTS_MODE=test', 'PAYMENTS_MODE=live') });
  await rejects(f, 'live_mode_refused'); assert.equal(f.calls.length, 0);
  const g = await fixture(t, { env: internalEnv.replace(KEY, 'sk_live_private') });
  await rejects(g, 'test_key_required'); assert.equal(g.calls.length, 0);
});

test('unsupported internal network settings are refused before network access', async t => {
  for (const value of ['unknown', 'profile_test_other', 'true']) {
    const f = await fixture(t, { env: internalEnv.replace('STRIPE_TEST_NETWORK_ID=internal', `STRIPE_TEST_NETWORK_ID=${value}`) });
    await rejects(f, 'unsupported_test_network'); assert.equal(f.calls.length, 0);
  }
});
