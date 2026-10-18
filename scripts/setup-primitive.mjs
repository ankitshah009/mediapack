#!/usr/bin/env node
// Discover an existing account and prepare a disabled, explicitly owned receiver.
import { parseArgs, parseEnv } from 'node:util';
import { readFile, writeFile, mkdir, rename, chmod, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const API = 'https://api.primitive.dev/v1';
const OWNER = 'mediapack-primitive-setup-v1';
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
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
export function replaceEnv(original, updates) {
  const keys = new Set(Object.keys(updates));
  const lines = original.split(/\r?\n/).filter(line => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    return !match || !keys.has(match[1]);
  });
  while (lines.at(-1) === '') lines.pop();
  for (const [key, value] of Object.entries(updates)) {
    if (typeof value !== 'string' || /[\r\n\0]/.test(value)) fail('invalid_configuration', 'A Primitive setting has an invalid value.', 'Check the private env file.');
    lines.push(`${key}=${JSON.stringify(value)}`);
  }
  return `${lines.join('\n')}\n`;
}
function originOnly(value) {
  let url;
  try { url = new URL(value); } catch { fail('invalid_origin', 'A deployed HTTPS origin is required.', 'Pass --origin or run the Blaxel hosting helper first.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    fail('invalid_origin', 'The webhook origin must be HTTPS without credentials, path, query or fragment.', 'Pass the deployed HTTPS origin.');
  }
  return url.origin;
}
function validDomain(domain) {
  return typeof domain === 'string' && domain.length <= 253 && domain.split('.').length > 1 &&
    domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}
function addressDomain(address, domains) {
  if (typeof address !== 'string' || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[^@\s]+$/i.test(address)) return undefined;
  return domains.find(domain => domain.domain.toLowerCase() === address.split('@')[1].toLowerCase());
}
function ownedEndpoint(endpoint, state, accountId) {
  return state?.owner === OWNER && state.account_id === accountId && state.endpoint_id === endpoint.id &&
    (endpoint.kind ?? 'http') === 'http' && !endpoint.is_route_target;
}

export async function setupPrimitive({ rootDir = ROOT, envFile = 'apps/web/.env.blaxel', origin,
  apply = false, fetchImpl = fetch, credentialsFile = resolve(homedir(), '.config/primitive/credentials.json'),
  now = Date.now } = {}) {
  const envPath = resolve(rootDir, envFile);
  const original = await optionalFile(envPath) ?? '';
  const env = parseEnv(original);
  const persistentKey = env.PRIMITIVE_API_KEY?.trim();
  let token = persistentKey, auth = 'api_key';
  if (!token) {
    auth = apply ? 'cli_oauth_control_plane_only' : 'cli_oauth_discovery_only';
    let credentials;
    try { credentials = JSON.parse(await optionalFile(credentialsFile) ?? 'null'); } catch { /* handled below */ }
    if (credentials?.auth_method !== 'oauth' || credentials.token_type !== 'Bearer' || !credentials.access_token ||
        !Number.isFinite(Date.parse(credentials.expires_at)) || Date.parse(credentials.expires_at) <= now()) {
      fail('authentication_required', 'No usable Primitive account credential is available.', 'Run primitive login for discovery, or save PRIMITIVE_API_KEY in the private env file.');
    }
    token = credentials.access_token;
  }
  async function request(path, method = 'GET', body) {
    let response;
    try {
      response = await fetchImpl(`${API}${path}`, { method, headers: { authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(20_000) });
    } catch { fail('primitive_unreachable', 'Primitive could not be reached securely within the request deadline.', 'Check connectivity and account login, then rerun. Do not retry an unknown endpoint mutation blindly.'); }
    if (!response.ok) {
      const code = response.status === 409 ? 'endpoint_conflict' : 'primitive_api_error';
      fail(code, `Primitive setup request failed (HTTP ${response.status}).`, response.status === 409
        ? 'Review existing routing in the Primitive dashboard. No unrelated endpoint was modified.'
        : 'Check the account credential, its permissions and the Primitive dashboard.');
    }
    let result;
    try { result = await response.json(); } catch { fail('invalid_api_response', 'Primitive returned an unreadable response.', 'Check provider status before retrying.'); }
    if (result?.success !== true || result.data === undefined) fail('invalid_api_response', 'Primitive returned an incomplete response.', 'Check provider status before retrying.');
    return result.data;
  }
  // Signing-secret GET can generate a secret on first access, so plan omits it.
  const [account, domains, endpoints, permissions] = await Promise.all([
    request('/account'), request('/domains'), request('/endpoints'), request('/send-permissions'),
  ]);
  if (typeof account?.id !== 'string' || !Array.isArray(domains) || !Array.isArray(endpoints) || !Array.isArray(permissions)) {
    fail('invalid_api_response', 'Primitive discovery returned an unexpected account shape.', 'Check the installed API contract before applying setup.');
  }
  const activeDomains = domains.filter(row => row.verified === true && row.is_active === true && validDomain(row.domain));
  const managed = activeDomains.filter(row => row.domain.toLowerCase().endsWith('.primitive.email'))
    .sort((a, b) => a.domain.localeCompare(b.domain));
  let control = env.PRIMITIVE_CONTROL_ADDRESS?.trim(), worker = env.PRIMITIVE_WORKER_ADDRESS?.trim();
  if (!addressDomain(control, activeDomains)) control = managed[0] && `control@${managed[0].domain}`;
  if (!addressDomain(worker, activeDomains)) worker = managed[0] && `worker@${managed[0].domain}`;
  if (!control || !worker) fail('managed_domain_required', 'No verified active domain is available for both application addresses.', 'Verify a managed Primitive domain or configure valid control and worker addresses on verified account domains.');
  if (control.toLowerCase() === worker.toLowerCase()) fail('distinct_addresses_required', 'Control and worker addresses must differ.', 'Set separate addresses in the private env file.');
  // One org-wide HTTP endpoint works without paid per-domain routing features.
  const domainId = null;
  let state;
  try { state = JSON.parse(await optionalFile(resolve(rootDir, '.blaxel/primitive-setup.json')) ?? 'null'); }
  catch { fail('invalid_ownership_state', 'Primitive endpoint ownership state is unreadable.', 'Restore the private setup state before changing endpoint routing.'); }
  const owned = endpoints.filter(endpoint => ownedEndpoint(endpoint, state, account.id));
  if (owned.length > 1) fail('ambiguous_endpoint', 'Multiple owned endpoints were returned.', 'Review the private setup state and dashboard.');
  if (state?.endpoint_id && (state.owner !== OWNER || state.account_id !== account.id)) {
    fail('account_mismatch', 'Saved endpoint ownership belongs to a different setup account.', 'Use the original account or a separate private setup directory.');
  }
  if (!origin) {
    let host;
    try { host = JSON.parse(await optionalFile(resolve(rootDir, '.blaxel/web-host.json')) ?? 'null'); }
    catch { fail('invalid_host_state', 'Blaxel hosting state is unreadable.', 'Pass --origin explicitly.'); }
    origin = host?.origin;
  }
  origin = originOnly(origin);
  const target = `${origin}/webhooks/primitive`;
  // Recover only our dedicated disabled destination after an interrupted save.
  const recovered = !owned.length && endpoints.find(endpoint => endpoint.url === target &&
    endpoint.enabled === false && (endpoint.kind ?? 'http') === 'http' && !endpoint.is_route_target &&
    (endpoint.domain_id ?? null) === domainId && endpoint.rules?.event_types?.length === 1 && endpoint.rules.event_types[0] === 'email.received');
  let endpoint = owned[0] || recovered;
  const conflict = endpoints.some(row => row.id !== endpoint?.id && row.enabled && !row.is_route_target &&
    row.kind !== 'pull' && (domainId === null || row.domain_id == null || row.domain_id === domainId));
  const report = {
    mode: apply ? 'apply' : 'plan', authentication: auth, verified_active_domain_count: activeDomains.length,
    control_address_configured: Boolean(addressDomain(env.PRIMITIVE_CONTROL_ADDRESS, activeDomains)),
    worker_address_configured: Boolean(addressDomain(env.PRIMITIVE_WORKER_ADDRESS, activeDomains)),
    persistent_api_key_present: Boolean(persistentKey), worker_api_key_present: Boolean(env.PRIMITIVE_WORKER_API_KEY?.trim()),
    runtime_api_key_configured: Boolean(persistentKey),
    webhook_secret_present: Boolean(env.PRIMITIVE_WEBHOOK_SECRET?.trim()),
    send_permission_types: [...new Set(permissions.map(row => row.type).filter(value => ['any_recipient', 'managed_zone', 'your_domain', 'address'].includes(value)))].sort(),
    endpoint_action: conflict ? 'blocked_unrelated_routing' : endpoint ? endpoint.url !== target ? 'rotate_owned_endpoint_url' : endpoint.enabled ? 'disable_owned_endpoint' : 'reuse_owned_disabled_endpoint' : 'create_disabled_endpoint',
    endpoint_enabled: endpoint?.enabled ?? false,
    activation: 'blocked_until_deployed_database_and_signature_verification',
    next_action: conflict ? 'Resolve conflicting routing in the Primitive dashboard; no takeover is attempted.' :
      apply ? `${!persistentKey ? 'Save a persistent PRIMITIVE_API_KEY privately for application runtime. ' : ''}Restart the hosted app with the updated env; verify database and webhook signatures before enabling the owned endpoint.` : 'Review this plan, then run --apply to save private settings and prepare a disabled endpoint.',
  };
  if (!apply) return report;
  if (conflict) fail('endpoint_conflict', 'An unrelated active endpoint already owns overlapping routing.', report.next_action);
  const secret = await request('/account/webhook-secret');
  if (typeof secret?.secret !== 'string' || !secret.secret.trim()) fail('invalid_api_response', 'Primitive did not return a webhook signing secret.', 'Check account permissions. No signing secret was rotated.');
  if ((await optionalFile(envPath) ?? '') !== original) fail('configuration_changed', 'The private env file changed during discovery.', 'Rerun setup to preserve the latest settings.');
  await privateWrite(envPath, replaceEnv(original, {
    PRIMITIVE_WEBHOOK_SECRET: secret.secret,
    PRIMITIVE_CONTROL_ADDRESS: control, PRIMITIVE_WORKER_ADDRESS: worker,
    ...(persistentKey && !env.PRIMITIVE_WORKER_API_KEY?.trim() ? { PRIMITIVE_WORKER_API_KEY: persistentKey } : {}),
  }));
  const desired = { enabled: false, domain_id: domainId, rules: { event_types: ['email.received'] } };
  // Stable names belong to pull subscriptions, not HTTP receivers.
  if (!endpoint) endpoint = await request('/endpoints', 'POST', { kind: 'http', url: target, ...desired });
  else if (endpoint.enabled || endpoint.url !== target || (endpoint.domain_id ?? null) !== domainId ||
      endpoint.rules?.event_types?.length !== 1 || endpoint.rules.event_types[0] !== 'email.received') {
    endpoint = await request(`/endpoints/${encodeURIComponent(endpoint.id)}`, 'PATCH', {
      ...desired, ...(endpoint.url !== target ? { url: target } : {}),
    });
  }
  if (typeof endpoint?.id !== 'string' || !endpoint.id || endpoint.enabled !== false || endpoint.url !== target ||
      (endpoint.domain_id ?? null) !== domainId || endpoint.is_route_target || (endpoint.kind ?? 'http') !== 'http') {
    fail('endpoint_verification_failed', 'Primitive did not confirm the disabled application endpoint.', 'Inspect routing in the dashboard before retrying. No test delivery was sent.');
  }
  await privateWrite(resolve(rootDir, '.blaxel/primitive-setup.json'), `${JSON.stringify({
    owner: OWNER, account_id: account.id, endpoint_id: endpoint.id, origin, enabled: false,
    updated_at: new Date(now()).toISOString(),
  }, null, 2)}\n`);
  return { ...report, endpoint_enabled: false, webhook_secret_present: true,
    control_address_configured: true, worker_address_configured: true,
    worker_api_key_present: Boolean(env.PRIMITIVE_WORKER_API_KEY?.trim() || persistentKey),
    settings_saved: true, live: false };
}

async function main() {
  const { values } = parseArgs({ options: {
    plan: { type: 'boolean' }, apply: { type: 'boolean' }, origin: { type: 'string' },
    'env-file': { type: 'string', default: 'apps/web/.env.blaxel' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('Usage: node scripts/setup-primitive.mjs [--plan | --apply] [--origin HTTPS_ORIGIN] [--env-file PATH]\nDefault --plan only discovers account routing. --apply saves private settings and prepares a disabled webhook; it never sends mail, test deliveries or deploys CLI OAuth credentials.');
    return;
  }
  if (values.plan && values.apply) fail('invalid_options', 'Choose either --plan or --apply.', 'Use --plan for discovery or --apply for disabled endpoint setup.');
  console.log(JSON.stringify(await setupPrimitive({ apply: values.apply, origin: values.origin, envFile: values['env-file'] }), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(JSON.stringify(error instanceof SetupError ? { error: error.code, hint: error.message, next_action: error.next_action } : {
      error: 'primitive_setup_failed', hint: 'Primitive setup could not complete; no credentials or provider payloads were printed.',
      next_action: 'Check private file permissions and provider account state, then rerun --plan before applying.',
    }));
    process.exitCode = 1;
  });
}
