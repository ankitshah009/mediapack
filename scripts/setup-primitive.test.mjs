import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { setupPrimitive, replaceEnv, SetupError } from './setup-primitive.mjs';

const NOW = Date.parse('2026-10-17T23:00:00Z');
const ORIGIN = 'https://app.example.test';
const TARGET = `${ORIGIN}/webhooks/primitive`;
const SECRET = 'private-account-signing-material';
const APIKEY = 'prim_persistent_private_key';
const OAUTH = 'private-cli-access-token';
const OWNER = 'mediapack-primitive-setup-v1';

async function fixture(t, { env = `# keep this comment\nDATABASE_URL="private-db"\nPRIMITIVE_API_KEY=${APIKEY}\n`, endpoints = [], oauth = true } = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), 'mediapack-primitive-test-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await mkdir(join(rootDir, 'apps/web'), { recursive: true });
  await mkdir(join(rootDir, '.blaxel'));
  const envPath = join(rootDir, 'apps/web/.env.blaxel');
  await writeFile(envPath, env, { mode: 0o644 });
  await writeFile(join(rootDir, '.blaxel/web-host.json'), JSON.stringify({ origin: ORIGIN }));
  const credentialsFile = join(rootDir, 'cli-credentials.json');
  if (oauth) await writeFile(credentialsFile, JSON.stringify({ auth_method: 'oauth', token_type: 'Bearer',
    access_token: OAUTH, refresh_token: 'private-refresh-token', expires_at: new Date(NOW + 3_600_000).toISOString() }));
  const calls = [];
  const cloud = { endpoints: structuredClone(endpoints), nextId: 1 };
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init, body: init.body && JSON.parse(init.body) });
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    const path = new URL(url).pathname.replace('/v1', '');
    assert.equal(new URL(url).origin, 'https://api.primitive.dev');
    let data;
    if (path === '/account') data = { id: 'account-1', email: 'private-user@example.test', plan: 'developer' };
    else if (path === '/domains') data = [{ id: 'domain-1', domain: 'private-managed.primitive.email', verified: true, is_active: true }];
    else if (path === '/send-permissions') data = [{ type: 'managed_zone', zone: 'primitive.email', description: 'private-description' }];
    else if (path === '/account/webhook-secret') data = { secret: SECRET };
    else if (path === '/endpoints' && init.method === 'GET') data = cloud.endpoints;
    else if (path === '/endpoints' && init.method === 'POST') {
      data = { id: `endpoint-${cloud.nextId++}`, ...JSON.parse(init.body) }; cloud.endpoints.push(data);
    } else if (path.startsWith('/endpoints/') && init.method === 'PATCH') {
      const endpoint = cloud.endpoints.find(row => row.id === path.split('/').at(-1));
      assert.ok(endpoint, 'PATCH must address an existing endpoint');
      const change = JSON.parse(init.body);
      data = { ...endpoint, ...change, ...(change.url ? { id: `rotated-${cloud.nextId++}` } : {}) };
      cloud.endpoints[cloud.endpoints.indexOf(endpoint)] = data;
    } else assert.fail(`Unexpected request: ${init.method} ${path}`);
    return Response.json({ success: true, data });
  };
  const options = { rootDir, credentialsFile, fetchImpl, now: () => NOW };
  return { rootDir, envPath, credentialsFile, options, calls, cloud, env };
}
function endpoint(overrides = {}) {
  return { id: 'existing-endpoint', kind: 'http', url: TARGET, enabled: false, domain_id: null,
    rules: { event_types: ['email.received'] }, ...overrides };
}
async function saveOwnership(f, row, overrides = {}) {
  await writeFile(join(f.rootDir, '.blaxel/primitive-setup.json'), JSON.stringify({
    owner: OWNER, account_id: 'account-1', endpoint_id: row.id, origin: ORIGIN, ...overrides,
  }));
}

test('plan is read-only and its report contains no account identities or secrets', async t => {
  const f = await fixture(t);
  const result = await setupPrimitive(f.options);
  assert.equal(result.mode, 'plan');
  assert.equal(result.endpoint_action, 'create_disabled_endpoint');
  assert.ok(f.calls.every(call => call.method === 'GET'));
  assert.equal(f.calls.length, 4);
  assert.ok(!f.calls.some(call => call.url.endsWith('/webhook-secret')));
  assert.equal(await readFile(f.envPath, 'utf8'), f.env);
  const serialized = JSON.stringify(result);
  for (const value of [SECRET, APIKEY, OAUTH, 'private-user', 'private-managed', 'private-description', 'account-1', TARGET]) assert.ok(!serialized.includes(value));
});

test('OAuth setup creates a disabled org-wide endpoint without persisting access or refresh tokens', async t => {
  const f = await fixture(t, { env: 'DATABASE_URL="private-db"\n' });
  const result = await setupPrimitive({ ...f.options, apply: true });
  assert.equal(result.authentication, 'cli_oauth_control_plane_only');
  assert.equal(result.runtime_api_key_configured, false);
  assert.equal(result.worker_api_key_present, false);
  assert.equal(result.endpoint_enabled, false);
  assert.equal(result.live, false);
  const envText = await readFile(f.envPath, 'utf8');
  const env = parseEnv(envText);
  assert.equal(env.PRIMITIVE_WEBHOOK_SECRET, SECRET);
  assert.equal(env.PRIMITIVE_CONTROL_ADDRESS, 'control@private-managed.primitive.email');
  assert.equal(env.PRIMITIVE_WORKER_ADDRESS, 'worker@private-managed.primitive.email');
  assert.equal(env.PRIMITIVE_API_KEY, undefined);
  assert.equal(env.PRIMITIVE_WORKER_API_KEY, undefined);
  const stateText = await readFile(join(f.rootDir, '.blaxel/primitive-setup.json'), 'utf8');
  for (const value of [OAUTH, 'private-refresh-token']) assert.ok(!`${envText}${stateText}${JSON.stringify(result)}`.includes(value));
  const create = f.calls.find(call => call.method === 'POST');
  assert.equal(create.body.enabled, false);
  assert.equal(create.body.domain_id, null);
  assert.equal(create.body.url, TARGET);
  assert.equal(Object.hasOwn(create.body, 'name'), false);
  assert.deepEqual(Object.keys(create.body).sort(), ['domain_id', 'enabled', 'kind', 'rules', 'url']);
  assert.deepEqual(create.body.rules, { event_types: ['email.received'] });
  assert.ok(f.calls.every(call => call.headers.authorization === `Bearer ${OAUTH}`));
  assert.equal((await stat(f.envPath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.rootDir, '.blaxel/primitive-setup.json'))).mode & 0o777, 0o600);
});

test('persistent key is used for setup and worker fallback; repeated apply makes no duplicate endpoint', async t => {
  const f = await fixture(t);
  await setupPrimitive({ ...f.options, apply: true });
  await setupPrimitive({ ...f.options, apply: true });
  const env = parseEnv(await readFile(f.envPath, 'utf8'));
  assert.equal(env.PRIMITIVE_WORKER_API_KEY, APIKEY);
  assert.ok((await readFile(f.envPath, 'utf8')).includes('# keep this comment'));
  assert.equal(env.DATABASE_URL, 'private-db');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 0);
  assert.ok(f.calls.every(call => call.headers.authorization === `Bearer ${APIKEY}`));
});

test('preserves dedicated worker key and valid existing addresses', async t => {
  const f = await fixture(t, { env: `PRIMITIVE_API_KEY=${APIKEY}\nPRIMITIVE_WORKER_API_KEY=prim_worker\nPRIMITIVE_CONTROL_ADDRESS=existing-control@private-managed.primitive.email\nPRIMITIVE_WORKER_ADDRESS=existing-worker@private-managed.primitive.email\n` });
  await setupPrimitive({ ...f.options, apply: true });
  const env = parseEnv(await readFile(f.envPath, 'utf8'));
  assert.equal(env.PRIMITIVE_WORKER_API_KEY, 'prim_worker');
  assert.equal(env.PRIMITIVE_CONTROL_ADDRESS, 'existing-control@private-managed.primitive.email');
  assert.equal(env.PRIMITIVE_WORKER_ADDRESS, 'existing-worker@private-managed.primitive.email');
});

test('origin rotation changes only the saved owned endpoint and persists its rotated id', async t => {
  const owned = endpoint({ url: 'https://old.example.test/webhooks/primitive', enabled: true });
  const unrelated = endpoint({ id: 'unrelated', kind: 'pull', url: null, enabled: true });
  const f = await fixture(t, { endpoints: [owned, unrelated] });
  await saveOwnership(f, owned);
  await setupPrimitive({ ...f.options, apply: true });
  const updates = f.calls.filter(call => call.method === 'PATCH');
  assert.equal(updates.length, 1);
  assert.ok(updates[0].url.endsWith('/existing-endpoint'));
  assert.equal(updates[0].body.enabled, false);
  const saved = JSON.parse(await readFile(join(f.rootDir, '.blaxel/primitive-setup.json'), 'utf8'));
  assert.ok(saved.endpoint_id.startsWith('rotated-'));
  assert.deepEqual(f.cloud.endpoints[1], unrelated);
});

test('recovers a matching disabled endpoint after an interrupted state save', async t => {
  const f = await fixture(t, { endpoints: [endpoint()] });
  await setupPrimitive({ ...f.options, apply: true });
  assert.ok(!f.calls.some(call => call.method !== 'GET'));
  const saved = JSON.parse(await readFile(join(f.rootDir, '.blaxel/primitive-setup.json'), 'utf8'));
  assert.equal(saved.endpoint_id, 'existing-endpoint');
});

test('unrelated org-wide active endpoint blocks takeover and private env writes', async t => {
  const f = await fixture(t, { endpoints: [endpoint({ enabled: true, url: 'https://unrelated.example.test/hook' })] });
  const plan = await setupPrimitive(f.options);
  assert.equal(plan.endpoint_action, 'blocked_unrelated_routing');
  await assert.rejects(setupPrimitive({ ...f.options, apply: true }), error => error instanceof SetupError && error.code === 'endpoint_conflict');
  assert.ok(f.calls.every(call => call.method === 'GET'));
  assert.ok(!f.calls.some(call => call.url.endsWith('/webhook-secret')));
  assert.equal(await readFile(f.envPath, 'utf8'), f.env);
});

test('wrong account ownership and insecure origins fail before endpoint mutation', async t => {
  const f = await fixture(t, { endpoints: [endpoint()] });
  await saveOwnership(f, endpoint(), { account_id: 'other-account' });
  await assert.rejects(setupPrimitive({ ...f.options, apply: true }), { code: 'account_mismatch' });
  const other = await fixture(t);
  for (const origin of ['http://remote.example.test', 'https://user:secret@example.test', 'https://app.example.test/path', 'https://app.example.test?token=secret']) {
    await assert.rejects(setupPrimitive({ ...other.options, apply: true, origin }), { code: 'invalid_origin' });
  }
  assert.ok([...f.calls, ...other.calls].every(call => call.method === 'GET'));
});

test('expired CLI login fails locally without any API request', async t => {
  const f = await fixture(t, { env: '' });
  await writeFile(f.credentialsFile, JSON.stringify({ auth_method: 'oauth', token_type: 'Bearer', access_token: OAUTH, expires_at: new Date(NOW - 1).toISOString() }));
  await assert.rejects(setupPrimitive(f.options), { code: 'authentication_required' });
  assert.equal(f.calls.length, 0);
});

test('OAuth access tokens cannot masquerade as persistent control or worker runtime keys', async t => {
  for (const key of ['PRIMITIVE_API_KEY', 'PRIMITIVE_WORKER_API_KEY']) {
    const f = await fixture(t, { env: `PRIMITIVE_API_KEY=${APIKEY}\n${key}=prim_oat_private_short_lived_token\n` });
    await assert.rejects(setupPrimitive({ ...f.options, apply: true }), error => {
      assert.equal(error.code, 'expiring_runtime_credential');
      assert.match(error.next_action, /Settings > API keys/);
      assert.ok(!error.message.includes('private_short_lived_token'));
      return true;
    });
    assert.equal(f.calls.length, 0);
    assert.equal(await readFile(f.envPath, 'utf8'), f.env);
  }
});

test('API failures expose HTTP status and action but never provider payloads', async t => {
  const f = await fixture(t);
  const fetchImpl = async () => Response.json({ error: `private:${SECRET}:${APIKEY}` }, { status: 403 });
  await assert.rejects(setupPrimitive({ ...f.options, fetchImpl }), error => {
    assert.equal(error.code, 'primitive_api_error');
    assert.match(error.message, /403/);
    assert.ok(error.next_action);
    assert.ok(!JSON.stringify({ message: error.message, ...error }).includes(SECRET));
    return true;
  });
});

test('concurrent env edit is preserved and stops writes and endpoint creation', async t => {
  const f = await fixture(t);
  const fetchImpl = async (url, init) => {
    const response = await f.options.fetchImpl(url, init);
    if (url.endsWith('/webhook-secret')) await writeFile(f.envPath, `${f.env}USER_EDIT=keep\n`);
    return response;
  };
  await assert.rejects(setupPrimitive({ ...f.options, fetchImpl, apply: true }), { code: 'configuration_changed' });
  assert.ok((await readFile(f.envPath, 'utf8')).includes('USER_EDIT=keep'));
  assert.ok(f.calls.every(call => call.method === 'GET'));
});

test('env replacement removes duplicate target assignments and preserves unrelated entries', () => {
  const result = replaceEnv('# comment\nPRIMITIVE_WEBHOOK_SECRET=old\nexport PRIMITIVE_WEBHOOK_SECRET="older"\nOTHER="keep=value"\n', { PRIMITIVE_WEBHOOK_SECRET: SECRET });
  assert.equal(result.match(/PRIMITIVE_WEBHOOK_SECRET=/g).length, 1);
  assert.equal(parseEnv(result).OTHER, 'keep=value');
  assert.equal(parseEnv(result).PRIMITIVE_WEBHOOK_SECRET, SECRET);
  assert.throws(() => replaceEnv('', { PRIMITIVE_WEBHOOK_SECRET: 'invalid\nvalue' }), { code: 'invalid_configuration' });
});
