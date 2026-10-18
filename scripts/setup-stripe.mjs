#!/usr/bin/env node
// Validate persistent sandbox credentials and manage only MediaPack's test webhook.
import { parseArgs, parseEnv } from 'node:util';
import { readFile, writeFile, mkdir, rename, chmod, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OWNER = 'mediapack-stripe-setup-v1';
const VERSION = '2026-07-29.preview';
export class SetupError extends Error {
  constructor(code, message, nextAction) { super(message); this.code = code; this.next_action = nextAction; }
}
function fail(code, message, action) { throw new SetupError(code, message, action); }
async function optionalFile(path) {
  try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
async function privateWrite(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path); await chmod(path, 0o600);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
function replaceEnv(original, updates) {
  const keys = new Set(Object.keys(updates));
  const lines = original.split(/\r?\n/).filter(line => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    return !match || !keys.has(match[1]);
  });
  while (lines.at(-1) === '') lines.pop();
  for (const [key, value] of Object.entries(updates)) {
    if (typeof value !== 'string' || /[\r\n\0]/.test(value)) fail('invalid_configuration', 'A Stripe setting has an invalid value.', 'Check the private env file.');
    lines.push(`${key}=${JSON.stringify(value)}`);
  }
  return `${lines.join('\n')}\n`;
}
function originOnly(value) {
  let url;
  try { url = new URL(value); } catch { /* handled below */ }
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    fail('invalid_origin', 'A deployed HTTPS origin without credentials or a path is required.', 'Pass --origin or run the Blaxel hosting helper first.');
  }
  return url.origin;
}

export async function setupStripe({ rootDir = ROOT, envFile = 'apps/web/.env.blaxel', origin,
  apply = false, fetchImpl = fetch, now = Date.now } = {}) {
  const envPath = resolve(rootDir, envFile), statePath = resolve(rootDir, '.blaxel/stripe-setup.json');
  const original = await optionalFile(envPath) ?? '', env = parseEnv(original);
  if (env.PAYMENTS_MODE && env.PAYMENTS_MODE !== 'test') fail('live_mode_refused', 'Stripe setup supports test-mode payments only.', 'Set PAYMENTS_MODE=test in the private application env.');
  const testNetwork = env.STRIPE_TEST_NETWORK_ID?.trim();
  if (testNetwork && testNetwork !== 'internal') fail('unsupported_test_network', 'Only the explicit internal sandbox test network is supported.', 'Remove STRIPE_TEST_NETWORK_ID or set it to internal for the verified test-helper flow. Public wallets require a Stripe profile.');
  const key = env.STRIPE_SECRET_KEY?.trim();
  if (!key) fail('persistent_key_required', 'A persistent Stripe sandbox API key is required.', 'Save a dedicated sk_test_ or rk_test_ key in STRIPE_SECRET_KEY in the private env file. CLI OAuth is not a runtime credential.');
  if (!/^(sk|rk)_test_[A-Za-z0-9]+$/.test(key)) fail('test_key_required', 'Stripe setup refuses non-test or unsupported keys.', 'Use a persistent sk_test_ or rk_test_ sandbox key; do not copy CLI OAuth credentials.');
  if (env.STRIPE_PROFILE_ID && !/^profile_test_[A-Za-z0-9]+$/.test(env.STRIPE_PROFILE_ID)) {
    fail('test_profile_required', 'Stripe setup refuses a non-test profile.', 'Use the profile_test_ identity from the same Stripe sandbox as the key.');
  }
  if (!origin) {
    let host;
    try { host = JSON.parse(await optionalFile(resolve(rootDir, '.blaxel/web-host.json')) ?? 'null'); }
    catch { fail('invalid_host_state', 'Blaxel host state is unreadable.', 'Pass --origin explicitly.'); }
    origin = host?.origin;
  }
  origin = originOnly(origin);
  const target = `${origin}/webhooks/stripe`;
  async function request(path, method = 'GET', fields, idempotency) {
    let response;
    try {
      response = await fetchImpl(`https://api.stripe.com${path}`, {
        method, headers: { authorization: `Bearer ${key}`, 'Stripe-Version': VERSION,
          ...(fields ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          ...(idempotency ? { 'Idempotency-Key': idempotency } : {}) },
        ...(fields ? { body: new URLSearchParams(fields).toString() } : {}),
        redirect: 'error', signal: AbortSignal.timeout(20_000),
      });
    } catch { fail('stripe_unreachable', 'Stripe could not be reached securely within the request deadline.', 'Check connectivity, then rerun --plan before retrying a mutation.'); }
    if (!response.ok) {
      if (path === '/v2/network/business_profiles/me' && response.status === 404) {
        // This opt-in is only for Stripe's real sandbox test-helper SPT flow.
        // Never replace a configured profile or hide permission/API failures.
        if (testNetwork === 'internal' && !env.STRIPE_PROFILE_ID) return undefined;
        fail('sandbox_profile_required', 'This Stripe sandbox has no usable business profile.', 'Create its Stripe profile at https://dashboard.stripe.com/profiles while viewing the MediaPack sandbox, then rerun setup.');
      }
      fail('stripe_api_error', `Stripe setup request failed (HTTP ${response.status}).`, 'Check the sandbox key and its permissions in the Stripe Dashboard; provider payloads were not logged.');
    }
    let result;
    try { result = await response.json(); } catch { fail('invalid_api_response', 'Stripe returned an unreadable response.', 'Check provider status before retrying.'); }
    return result;
  }
  const [account, profile] = await Promise.all([
    request('/v1/account'), request('/v2/network/business_profiles/me'),
  ]);
  if (!/^acct_[A-Za-z0-9]+$/.test(account?.id ?? '') ||
      (profile !== undefined && !/^profile_test_[A-Za-z0-9]+$/.test(profile?.id ?? ''))) {
    fail('invalid_api_response', 'Stripe did not return a sandbox account and test profile.', 'Verify the API key and sandbox profile belong to the same Stripe environment.');
  }
  if (env.STRIPE_PROFILE_ID && env.STRIPE_PROFILE_ID !== profile.id) fail('profile_mismatch', 'The configured Stripe profile belongs to a different identity.', 'Review the intended sandbox before replacing STRIPE_PROFILE_ID.');
  const networkId = profile?.id ?? 'internal';
  let state;
  try { state = JSON.parse(await optionalFile(statePath) ?? 'null'); }
  catch { fail('invalid_ownership_state', 'Stripe webhook ownership state is unreadable.', 'Restore the private setup state before changing webhook routing.'); }
  if (state && (state.owner !== OWNER || state.account_id !== account.id)) {
    fail('account_mismatch', 'Saved Stripe setup belongs to another account.', 'Use its original sandbox or a separate private setup directory.');
  }
  const endpoints = [];
  let after;
  do {
    if (endpoints.length >= 2000) fail('too_many_endpoints', 'The webhook list exceeds this setup helper\'s discovery limit.', 'Review the Stripe Dashboard before applying setup.');
    const page = await request(`/v1/webhook_endpoints?limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ''}`);
    if (!Array.isArray(page?.data) || typeof page.has_more !== 'boolean' || page.data.some(row => row.livemode !== false)) {
      fail('invalid_api_response', 'Stripe returned an unexpected test webhook list.', 'Verify the sandbox key and provider API contract.');
    }
    endpoints.push(...page.data);
    after = page.has_more && page.data.at(-1)?.id;
    if (page.has_more && !after) fail('invalid_api_response', 'Stripe pagination returned an empty continuation page.', 'Check provider status before retrying.');
  } while (after);
  const owned = endpoints.filter(row => row.metadata?.mediapack_setup === OWNER);
  if (owned.length > 1) fail('ambiguous_endpoint', 'Multiple MediaPack-owned Stripe webhooks exist.', 'Review the Stripe Dashboard before applying setup.');
  let endpoint = owned[0];
  if (state?.endpoint_id && state.endpoint_id !== endpoint?.id) fail('ownership_mismatch', 'The saved Stripe webhook is missing or no longer owned by this setup.', 'Review the saved endpoint and Stripe Dashboard; unrelated endpoints are never changed.');
  const needsUpdate = endpoint && (endpoint.url !== target || endpoint.status !== 'enabled' ||
    endpoint.enabled_events?.length !== 1 || endpoint.enabled_events[0] !== 'payment_intent.succeeded');
  const report = { mode: apply ? 'apply' : 'plan', payments_mode: 'test', persistent_test_key_present: true,
    account_verified: true, test_profile_verified: Boolean(profile),
    payment_identity: profile ? 'sandbox_profile' : 'sandbox_internal', public_wallet_profile_required: !profile,
    webhook_action: endpoint ? needsUpdate ? 'update_owned_test_endpoint' : 'reuse_owned_test_endpoint' : 'create_owned_test_endpoint',
    webhook_secret_present: Boolean(env.STRIPE_WEBHOOK_SECRET?.startsWith('whsec_')),
    next_action: apply ? 'Restart the hosted app with these settings, verify webhook signatures, then execute the authorized test purchase.' :
      'Review this plan, then run --apply after the deployed database and HTTPS receiver are ready.' };
  if (!apply) return report;
  if ((await optionalFile(envPath) ?? '') !== original) fail('configuration_changed', 'The private env file changed during discovery.', 'Rerun setup to preserve the latest settings.');
  if (endpoint && !env.STRIPE_WEBHOOK_SECRET?.startsWith('whsec_')) {
    fail('webhook_secret_required', 'The existing owned webhook signing secret is missing locally.', 'Restore STRIPE_WEBHOOK_SECRET from this exact endpoint in the Dashboard. Existing signing secrets cannot be recovered through the API.');
  }
  const fields = { url: target, 'enabled_events[0]': 'payment_intent.succeeded',
    'metadata[mediapack_setup]': OWNER, description: 'MediaPack test-mode payment reconciliation' };
  if (!endpoint) endpoint = await request('/v1/webhook_endpoints', 'POST', fields, `mediapack-webhook-${account.id}-${new URL(origin).hostname}`);
  else if (needsUpdate) endpoint = await request(`/v1/webhook_endpoints/${encodeURIComponent(endpoint.id)}`, 'POST', { ...fields, disabled: 'false' });
  const secret = endpoint?.secret ?? env.STRIPE_WEBHOOK_SECRET;
  if (!/^we_[A-Za-z0-9]+$/.test(endpoint?.id ?? '') || endpoint.livemode !== false || endpoint.url !== target || endpoint.status !== 'enabled' ||
      endpoint.metadata?.mediapack_setup !== OWNER || endpoint.enabled_events?.length !== 1 || endpoint.enabled_events[0] !== 'payment_intent.succeeded' || !secret?.startsWith('whsec_')) {
    fail('endpoint_verification_failed', 'Stripe did not confirm the owned test webhook and signing secret.', 'Inspect the endpoint in the Stripe Dashboard before retrying. No payment was attempted.');
  }
  if ((await optionalFile(envPath) ?? '') !== original) fail('configuration_changed', 'The private env file changed during endpoint setup.', 'Recover the owned webhook secret in the Dashboard and rerun with the latest settings.');
  await privateWrite(envPath, replaceEnv(original, { PAYMENTS_MODE: 'test',
    ...(profile ? { STRIPE_PROFILE_ID: profile.id } : {}), STRIPE_WEBHOOK_SECRET: secret }));
  await privateWrite(statePath, `${JSON.stringify({ owner: OWNER, account_id: account.id, endpoint_id: endpoint.id,
    profile_id: profile?.id ?? null, network_id: networkId, origin, updated_at: new Date(now()).toISOString(), livemode: false }, null, 2)}\n`);
  return { ...report, webhook_secret_present: true, settings_saved: true, payment_attempted: false };
}

async function main() {
  const { values } = parseArgs({ options: { plan: { type: 'boolean' }, apply: { type: 'boolean' },
    origin: { type: 'string' }, 'env-file': { type: 'string', default: 'apps/web/.env.blaxel' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) { console.log('Usage: node scripts/setup-stripe.mjs [--plan | --apply] [--origin HTTPS_ORIGIN] [--env-file PATH]\nDefault --plan is read-only. --apply configures only an owned TEST payment webhook and private env settings. STRIPE_TEST_NETWORK_ID=internal explicitly permits the sandbox test-helper flow when no profile exists; public wallets still require a Stripe profile. Setup never creates a payment or copies CLI OAuth credentials.'); return; }
  if (values.plan && values.apply) fail('invalid_options', 'Choose --plan or --apply.', 'Use --plan for read-only discovery.');
  console.log(JSON.stringify(await setupStripe({ apply: values.apply, origin: values.origin, envFile: values['env-file'] }), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(JSON.stringify(error instanceof SetupError ? { error: error.code, hint: error.message, next_action: error.next_action } : {
      error: 'stripe_setup_failed', hint: 'Stripe setup could not complete; no credentials or provider payloads were printed.',
      next_action: 'Check private file permissions and Stripe account state, then rerun --plan.',
    })); process.exitCode = 1;
  });
}
