import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { setupSupabase, safeError, BUCKET, BUCKET_OPTIONS } from './setup-supabase.mjs';

const DATABASE = 'postgresql://private-user:private-password@private-db.example.test:5432/postgres';
const ORIGIN = 'https://private-project.example.test';
const KEY = 'private-service-role-credential';
const ENV = `DATABASE_URL=${JSON.stringify(DATABASE)}\nSUPABASE_URL=${ORIGIN}\nSUPABASE_SERVICE_ROLE_KEY=${KEY}\n`;
const INITIAL_SQL = 'create table clients (id uuid primary key);\ncreate function app_event() returns void language plpgsql as $$ begin perform 1; end $$;\n';
const hash = text => createHash('sha256').update(text).digest('hex');
const bucketRow = () => ({ id: BUCKET, public: false, file_size_limit: BUCKET_OPTIONS.fileSizeLimit,
  allowed_mime_types: [...BUCKET_OPTIONS.allowedMimeTypes] });

async function fixture(t, { env = ENV, migrations = { '0001_init.sql': INITIAL_SQL }, bucket = null,
  state = { ledger: false, applied: [], objects: [] }, failMigration = false, mutateReadback,
  storageError } = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), 'mediapack-supabase-test-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await mkdir(join(rootDir, 'apps/web'), { recursive: true });
  await mkdir(join(rootDir, 'supabase/migrations'), { recursive: true });
  await writeFile(join(rootDir, 'apps/web/.env.blaxel'), env, { mode: 0o600 });
  for (const [name, text] of Object.entries(migrations)) await writeFile(join(rootDir, 'supabase/migrations', name), text);
  const calls = [], database = { state: structuredClone(state), endCalls: 0 }, cloud = { bucket: structuredClone(bucket) };
  let dbOptions, clientOptions;
  const sql = {
    async begin(mode, callback) {
      calls.push({ type: 'begin', mode });
      const snapshot = structuredClone(database.state);
      try {
        const result = await callback({ async unsafe(query, params = []) {
          calls.push({ type: 'query', query, params, mode });
          if (mode === 'read only') assert.ok(/^\s*(?:select|set local)\b/i.test(query), 'plan must not mutate');
          if (query.startsWith('set local') || query.startsWith('select pg_catalog.pg_advisory_xact_lock')) return [];
          if (query.includes("to_regclass('mediapack_setup.migrations')")) return [{ ledger: database.state.ledger ? 'mediapack_setup.migrations' : null }];
          if (query.startsWith('select filename')) return structuredClone(database.state.applied);
          if (query.startsWith('select c.relname')) return structuredClone(database.state.objects);
          if (query.startsWith('create schema if not exists mediapack_setup')) { database.state.ledger = true; return []; }
          if (query.startsWith('insert into mediapack_setup.migrations')) {
            database.state.applied.push({ filename: params[0], sha256: params[1] }); return [];
          }
          // This fake is the database I/O edge; migration logic runs unchanged.
          if (failMigration) {
            database.state.objects.push({ name: 'clients', kind: 'table' });
            throw new Error(`${KEY}:${DATABASE}: simulated server rejection`);
          }
          for (const [, kind, name] of query.matchAll(/\bcreate\s+(table|function)\s+([a-z_][a-z0-9_]*)/gi)) {
            database.state.objects.push({ kind: kind.toLowerCase(), name: name.toLowerCase() });
          }
          return [];
        } });
        calls.push({ type: 'commit', mode }); return result;
      } catch (error) { database.state = snapshot; calls.push({ type: 'rollback', mode }); throw error; }
    },
    async end() { database.endCalls++; },
  };
  const postgresFactory = (url, options) => { assert.equal(url, DATABASE); dbOptions = options; return sql; };
  const storage = {
    async getBucket(name) {
      assert.equal(name, BUCKET); calls.push({ type: 'getBucket' });
      if (storageError) return { data: null, error: storageError };
      if (!cloud.bucket) return { data: null, error: { statusCode: '404', message: `${KEY}: private payload` } };
      return { data: structuredClone(cloud.bucket), error: null };
    },
    async createBucket(name, options) {
      calls.push({ type: 'createBucket', name, options }); assert.equal(cloud.bucket, null);
      cloud.bucket = mutateReadback ? mutateReadback(bucketRow()) : bucketRow();
      return { data: { name }, error: null };
    },
    async updateBucket(name, options) {
      calls.push({ type: 'updateBucket', name, options }); assert.ok(cloud.bucket);
      cloud.bucket = mutateReadback ? mutateReadback(bucketRow()) : bucketRow();
      return { data: { name }, error: null };
    },
  };
  const createClient = (url, key, options) => {
    assert.equal(url, ORIGIN); assert.equal(key, KEY); clientOptions = options; return { storage };
  };
  return { rootDir, calls, database, cloud, options: { rootDir, postgresFactory, createClient },
    dbOptions: () => dbOptions, clientOptions: () => clientOptions };
}

test('default plan is read-only, has exact required settings, and never reports credentials', async t => {
  const f = await fixture(t);
  const report = await setupSupabase(f.options);
  assert.equal(report.mode, 'plan');
  assert.equal(report.migrations_pending, 1);
  assert.equal(report.bucket_action, 'create');
  assert.equal(report.bucket_configuration_verified, false);
  assert.equal(report.global_upload_limit_verified, false);
  assert.ok(!f.calls.some(call => call.type === 'createBucket' || call.type === 'updateBucket'));
  assert.ok(f.calls.filter(call => call.type === 'begin').every(call => call.mode === 'read only'));
  assert.deepEqual(f.database.state, { ledger: false, applied: [], objects: [] });
  assert.equal(await readFile(join(f.rootDir, 'apps/web/.env.blaxel'), 'utf8'), ENV);
  for (const secret of [DATABASE, ORIGIN, KEY, 'private-user', 'private-password']) assert.ok(!JSON.stringify(report).includes(secret));
  assert.equal(f.dbOptions().ssl, true);
  assert.equal(f.dbOptions().prepare, false);
  assert.equal(f.dbOptions().connect_timeout, 10);
  assert.equal(f.clientOptions().auth.persistSession, false);
  assert.equal(f.clientOptions().auth.autoRefreshToken, false);
});

test('apply records atomic checksums, configures exact private bucket, and a second apply reuses both', async t => {
  const f = await fixture(t);
  const result = await setupSupabase({ ...f.options, apply: true });
  assert.equal(result.migrations_applied, 1);
  assert.equal(result.migrations_pending, 0);
  assert.equal(result.bucket_action, 'create');
  assert.equal(result.bucket_configuration_verified, true);
  assert.deepEqual(f.database.state.applied, [{ filename: '0001_init.sql', sha256: hash(INITIAL_SQL) }]);
  assert.deepEqual(f.calls.find(call => call.type === 'createBucket').options, BUCKET_OPTIONS);
  assert.deepEqual(f.cloud.bucket, bucketRow());
  const second = await setupSupabase({ ...f.options, apply: true });
  assert.equal(second.migrations_applied, 0);
  assert.equal(second.migrations_previously_applied, 1);
  assert.equal(second.bucket_action, 'reuse');
  assert.equal(f.calls.filter(call => call.type === 'createBucket').length, 1);
  assert.equal(f.calls.filter(call => call.type === 'query' && call.query === INITIAL_SQL).length, 1);
});

test('multiple migrations are applied in order with a separate atomic transaction for each', async t => {
  const second = 'create table videos (id uuid primary key);';
  const f = await fixture(t, { migrations: { '0002_videos.sql': second, '0001_init.sql': INITIAL_SQL } });
  const report = await setupSupabase({ ...f.options, apply: true });
  assert.equal(report.migrations_applied, 2);
  assert.deepEqual(f.database.state.applied.map(row => row.filename), ['0001_init.sql', '0002_videos.sql']);
  assert.equal(f.calls.filter(call => call.type === 'commit' && call.mode === '').length, 2);
  assert.equal(f.calls.filter(call => call.type === 'query' && call.query.includes('pg_advisory_xact_lock')).length, 4);
});

test('migration checksum changes and missing local history are refused before writes', async t => {
  for (const applied of [
    [{ filename: '0001_init.sql', sha256: '0'.repeat(64) }],
    [{ filename: 'deleted_migration.sql', sha256: hash(INITIAL_SQL) }],
  ]) {
    const f = await fixture(t, { state: { ledger: true, applied, objects: [] } });
    await assert.rejects(setupSupabase({ ...f.options, apply: true }), { code: 'migration_drift' });
    assert.ok(!f.calls.some(call => call.type === 'begin' && call.mode === ''));
    assert.ok(!f.calls.some(call => call.type === 'createBucket'));
  }
});

test('an untracked partial app schema is refused instead of replayed or baselined', async t => {
  for (const ledger of [false, true]) {
    const f = await fixture(t, { state: { ledger, applied: [], objects: [{ kind: 'table', name: 'clients' }] } });
    await assert.rejects(setupSupabase({ ...f.options, apply: true }), { code: 'untracked_app_schema' });
    assert.equal(f.database.state.applied.length, 0);
    assert.ok(!f.calls.some(call => call.type === 'createBucket'));
  }
});

test('missing recorded objects or pre-applied pending objects are schema drift', async t => {
  const f = await fixture(t, { state: { ledger: true,
    applied: [{ filename: '0001_init.sql', sha256: hash(INITIAL_SQL) }], objects: [{ name: 'clients', kind: 'table' }] } });
  await assert.rejects(setupSupabase(f.options), { code: 'schema_drift' });
});

test('failed DDL rolls back schema and ledger together; bucket is never changed', async t => {
  const f = await fixture(t, { failMigration: true });
  await assert.rejects(setupSupabase({ ...f.options, apply: true }), error => {
    assert.equal(error.code, 'supabase_setup_failed');
    for (const secret of [KEY, DATABASE, 'simulated server rejection']) assert.ok(!JSON.stringify(safeError(error)).includes(secret));
    return true;
  });
  assert.deepEqual(f.database.state, { ledger: false, applied: [], objects: [] });
  assert.ok(f.calls.some(call => call.type === 'rollback' && call.mode === ''));
  assert.ok(!f.calls.some(call => call.type === 'createBucket'));
  assert.equal(f.database.endCalls, 1);
});

test('existing bucket is made private with exact MIME types and 50 MiB limit', async t => {
  const f = await fixture(t, { bucket: { id: BUCKET, public: true, file_size_limit: 52428800, allowed_mime_types: ['*/*'] } });
  const plan = await setupSupabase(f.options);
  assert.equal(plan.bucket_action, 'update');
  assert.equal(plan.bucket_private, false);
  const result = await setupSupabase({ ...f.options, apply: true });
  assert.equal(result.bucket_action, 'update');
  assert.deepEqual(f.calls.find(call => call.type === 'updateBucket').options, BUCKET_OPTIONS);
  assert.ok(!f.calls.some(call => call.type === 'createBucket'));
});

test('bucket readback refuses provider downgrade and leaves successful migrations tracked', async t => {
  const f = await fixture(t, { mutateReadback: row => ({ ...row, file_size_limit: 25 * 1024 ** 2 }) });
  await assert.rejects(setupSupabase({ ...f.options, apply: true }), error => {
    assert.equal(error.code, 'storage_configuration_failed');
    assert.match(error.next_action, /52428800/);
    assert.match(error.next_action, /50 MiB/);
    return true;
  });
  assert.equal(f.database.state.applied.length, 1);
});

test('storage authentication failures do not look like absent buckets or expose payloads', async t => {
  const f = await fixture(t, { storageError: { statusCode: '403', message: `${KEY}:${ORIGIN}: private details` } });
  await assert.rejects(setupSupabase({ ...f.options, apply: true }), error => {
    assert.equal(error.code, 'storage_configuration_failed');
    assert.ok(!JSON.stringify(safeError(error)).includes(KEY));
    assert.ok(!JSON.stringify(safeError(error)).includes(ORIGIN));
    return true;
  });
  assert.ok(!f.calls.some(call => call.type === 'begin' && call.mode === ''));
});

test('missing configuration and invalid URLs fail before DB or storage calls', async t => {
  for (const env of ['', ENV.replace(/^SUPABASE_URL=.*/m, 'SUPABASE_URL=http://insecure.example.test'),
    ENV.replace(/^SUPABASE_URL=.*/m, `SUPABASE_URL=https://user:${KEY}@private.example.test`),
    ENV.replace(/^DATABASE_URL=.*/m, 'DATABASE_URL=not-a-url')]) {
    const f = await fixture(t, { env });
    await assert.rejects(setupSupabase(f.options), error => ['missing_configuration', 'invalid_configuration'].includes(error.code));
    assert.equal(f.calls.length, 0);
  }
});

test('top-level transaction controls are blocked while real PL/pgSQL bodies remain valid', async t => {
  const original = await readFile(new URL('../supabase/migrations/0001_init.sql', import.meta.url), 'utf8');
  const valid = await fixture(t, { migrations: { '0001_init.sql': original } });
  assert.equal((await setupSupabase(valid.options)).migrations_pending, 1);
  for (const text of ['begin; create table clients(id int); commit;', "-- ignore begin;\nROLLBACK;", "do $$ begin perform 1; end $$; START TRANSACTION;"]) {
    const f = await fixture(t, { migrations: { '0001_init.sql': text } });
    await assert.rejects(setupSupabase({ ...f.options, apply: true }), { code: 'migration_transaction_control' });
    assert.equal(f.calls.length, 0);
  }
});

test('custom fetch imposes per-request timeout, whole-run signal and rejects redirects', async t => {
  const f = await fixture(t);
  let request;
  await setupSupabase({ ...f.options, fetchImpl: async (url, init) => { request = { url, ...init }; return Response.json({}); } });
  await f.clientOptions().global.fetch(`${ORIGIN}/storage/v1/bucket`, { method: 'GET' });
  assert.equal(request.redirect, 'error');
  assert.ok(request.signal instanceof AbortSignal);
});

test('CLI help is available without credentials and option failures have safe errors', () => {
  const script = resolve('scripts/setup-supabase.mjs');
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Default --plan is read-only/);
  for (const args of [['--plan', '--apply'], ['--unsupported-secret=value']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    const error = JSON.parse(result.stderr);
    assert.equal(error.error, 'invalid_options');
    assert.ok(error.hint && error.next_action);
    assert.ok(!result.stderr.includes('unsupported-secret=value'));
  }
});

test('disposable PostgreSQL executes the real migration, retries idempotently, and rolls back failed SQL', {
  skip: !process.env.MEDIAPACK_TEST_POSTGRES_BIN,
}, async t => {
  const bin = process.env.MEDIAPACK_TEST_POSTGRES_BIN;
  const directory = await mkdtemp(join(tmpdir(), 'mp-sb-pg-'));
  const dataDir = join(directory, 'data');
  let started = false;
  t.after(async () => {
    if (started) {
      const stopped = spawnSync(join(bin, 'pg_ctl'), ['stop', '-D', dataDir, '-m', 'fast', '-t', '10'], { encoding: 'utf8', timeout: 15_000 });
      assert.equal(stopped.status, 0, 'disposable Postgres must stop');
    }
    await rm(directory, { recursive: true, force: true });
  });
  const initialized = spawnSync(join(bin, 'initdb'), ['-D', dataDir, '-U', 'mp_setup', '--auth=trust', '--no-locale', '-E', 'UTF8'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(initialized.status, 0, 'disposable initdb must succeed');
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const launched = spawnSync(join(bin, 'pg_ctl'), ['start', '-D', dataDir, '-l', join(directory, 'boot.log'), '-t', '10',
    '-o', `-p ${port} -k ${directory} -c listen_addresses=127.0.0.1`], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(launched.status, 0, 'disposable pg_ctl must boot');
  started = true;
  const bootLog = await readFile(join(directory, 'boot.log'), 'utf8');
  assert.match(bootLog, /database system is ready to accept connections/);
  const require = createRequire(resolve('apps/mediapack/package.json'));
  const postgres = require('postgres');
  const url = `postgresql://mp_setup@127.0.0.1:${port}/postgres`;
  const db = postgres(url, { max: 1, ssl: false, onnotice: () => {} });
  t.after(() => db.end({ timeout: 1 }));
  const original = await readFile(new URL('../supabase/migrations/0001_init.sql', import.meta.url), 'utf8');
  const f = await fixture(t, { migrations: { '0001_init.sql': original } });
  await writeFile(join(f.rootDir, 'apps/web/.env.blaxel'), ENV.replace(DATABASE, url));
  const options = { ...f.options, postgresFactory: (connection, settings) => postgres(connection, { ...settings, ssl: false }) };
  const first = await setupSupabase({ ...options, apply: true });
  assert.equal(first.migrations_applied, 1);
  const second = await setupSupabase({ ...options, apply: true });
  assert.equal(second.migrations_applied, 0);
  const [{ count }] = await db`select count(*)::int as count from pg_tables where schemaname = 'public'`;
  assert.equal(count, 12);
  const [{ all_rls }] = await db`select bool_and(rowsecurity) as all_rls from pg_tables where schemaname = 'public'`;
  assert.equal(all_rls, true);
  const [{ recorded }] = await db`select count(*)::int as recorded from mediapack_setup.migrations`;
  assert.equal(recorded, 1);
  await writeFile(join(f.rootDir, 'supabase/migrations/0002_bad.sql'), 'create table rollback_probe(id int); select 1/0;');
  await assert.rejects(setupSupabase({ ...options, apply: true }), { code: 'supabase_setup_failed' });
  const [{ probe }] = await db`select to_regclass('public.rollback_probe') as probe`;
  assert.equal(probe, null);
  const [{ after_failure }] = await db`select count(*)::int as after_failure from mediapack_setup.migrations`;
  assert.equal(after_failure, 1);
});
