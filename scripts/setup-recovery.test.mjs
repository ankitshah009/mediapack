import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import { setupRecovery, safeError, schedulerSql, DUE_SQL, JOB_COMMAND, OWNER, SECRET_NAMES } from './setup-recovery.mjs';

const DATABASE = 'postgresql://private-user:private-password@private-db.example.test:5432/postgres';
const ORIGIN = 'https://current-app.example.test';
const TOKEN = 'synthetic-test-tick-token-never-use-in-production';
const ENV = `DATABASE_URL=${DATABASE}\nINTERNAL_TICK_TOKEN=${TOKEN}\n`;
const EMPTY_DUE = { stale_operations: false, expired_uploads: false, expired_packs: false,
  pending_primitive_events: false, pending_payments: false, due_outbox: false };
const extensions = () => [
  { name: 'pg_cron', default_version: '1.6.4', installed_version: null, schema: null },
  { name: 'pg_net', default_version: '0.20.4', installed_version: null, schema: null },
  { name: 'pgcrypto', default_version: '1.3', installed_version: '1.3', schema: 'extensions' },
  { name: 'supabase_vault', default_version: '0.3.1', installed_version: '0.3.1', schema: 'vault' },
];
const nonceRow = () => ({ marker: OWNER, owned: true, rls: true,
  columns: ['nonce:uuid', 'expires_at:timestamp with time zone'], expiry_index: true });

async function fixture(t, { env = ENV, state = {}, failDdl = false } = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), 'mediapack-recovery-test-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await mkdir(join(rootDir, 'apps/web'), { recursive: true });
  await mkdir(join(rootDir, '.blaxel'));
  await writeFile(join(rootDir, 'apps/web/.env.blaxel'), env, { mode: 0o600 });
  await writeFile(join(rootDir, '.blaxel/web-host.json'), JSON.stringify({ origin: ORIGIN }));
  const db = { state: { ready: true, schemaOwned: true, extensions: extensions(), objects: [], nonces: [], secrets: [], job: null,
    due: { ...EMPTY_DUE }, ...structuredClone(state) }, endCalls: 0 };
  const calls = [];
  let options;
  const sql = {
    async begin(mode, callback) {
      calls.push({ type: 'begin', mode });
      const snapshot = structuredClone(db.state);
      try {
        const result = await callback({ async unsafe(query, params = []) {
          calls.push({ type: 'query', mode, query, params });
          if (mode === 'read only') assert.match(query, /^(?:select|set local)\b/i, 'plan must not mutate');
          if (query.startsWith('set local') || query.startsWith('select pg_catalog.pg_advisory_xact_lock')) return [];
          if (query.startsWith("select to_regclass('mediapack_setup.migrations')")) return [{ ready: db.state.ready }];
          if (query.startsWith('select nspowner')) return [{ owned: db.state.schemaOwned }];
          if (query.startsWith('select a.name')) return structuredClone(db.state.extensions);
          if (query === 'select current_user') return [{ current_user: 'postgres' }];
          if (query.startsWith('select p.proname')) return structuredClone(db.state.objects);
          if (query.startsWith('select obj_description(c.oid')) return structuredClone(db.state.nonces);
          if (query.startsWith('select id, name, description')) return db.state.secrets.filter(row => params[0].includes(row.name)).map(({ value, ...metadata }) => metadata);
          if (query.startsWith('select jobid, username')) return db.state.job ? [structuredClone(db.state.job)] : [];
          if (query === DUE_SQL) return [structuredClone(db.state.due)];
          if (query.startsWith('create extension')) {
            const name = query.split(' ')[2], row = db.state.extensions.find(row => row.name === name);
            row.installed_version = row.default_version; row.schema = name === 'pg_cron' ? 'pg_catalog' : 'extensions'; return [];
          }
          if (query.startsWith('create table mediapack_setup.recovery_nonces')) { db.state.nonces = [nonceRow()]; return []; }
          if (query.startsWith('revoke all')) return [];
          if (query.startsWith('select decrypted_secret =')) return [{ matches: db.state.secrets.find(row => row.id === params[1]).value === params[0] }];
          if (query.startsWith('select vault.create_secret')) {
            db.state.secrets.push({ id: `secret-${db.state.secrets.length}`, name: params[1], description: params[2], value: params[0] }); return [];
          }
          if (query.startsWith('select vault.update_secret')) {
            const row = db.state.secrets.find(row => row.id === params[0]);
            row.value = params[1]; row.name = params[2]; row.description = params[3]; return [];
          }
          if (query.startsWith('create or replace function')) {
            if (failDdl) throw new Error(`${DATABASE}:${TOKEN}: private provider failure`);
            db.state.objects = ['recovery_due', 'dispatch_recovery_tick'].map(proname => ({ proname, pronargs: 0, marker: OWNER, owned: true })); return [];
          }
          if (query.startsWith('select cron.schedule')) {
            db.state.job = { jobid: db.state.job?.jobid ?? 17, username: 'postgres', command: params[2], schedule: params[1], active: true }; return [];
          }
          if (query.startsWith('select jobid from cron.job')) return [{ jobid: db.state.job.jobid }];
          if (query.startsWith('select cron.alter_job')) { db.state.job.active = true; return []; }
          throw new Error(`unexpected test query: ${query.slice(0, 60)}`);
        } });
        calls.push({ type: 'commit', mode }); return result;
      } catch (error) { db.state = snapshot; calls.push({ type: 'rollback', mode }); throw error; }
    },
    async end() { db.endCalls++; },
  };
  const postgresFactory = (url, value) => { assert.equal(url, new URL(env.match(/^DATABASE_URL=(.+)$/m)[1]).href); options = value; return sql; };
  return { rootDir, db, calls, options: { rootDir, postgresFactory }, dbOptions: () => options };
}

test('default plan only reads metadata and due work; never wakes Blaxel or discloses credentials', async t => {
  const f = await fixture(t);
  const report = await setupRecovery(f.options);
  assert.equal(report.mode, 'plan');
  assert.equal(report.schedule_enabled, false);
  assert.equal(report.recovery_due, false);
  assert.equal(report.idle_http_requests, 0);
  assert.deepEqual(report.extensions_to_enable, ['pg_cron', 'pg_net']);
  assert.deepEqual(report.due_reasons, EMPTY_DUE);
  assert.ok(f.calls.filter(call => call.type === 'begin').every(call => call.mode === 'read only'));
  assert.equal(f.db.state.secrets.length, 0);
  assert.equal(f.dbOptions().prepare, false);
  assert.equal(f.dbOptions().connect_timeout, 10);
  for (const secret of [DATABASE, TOKEN, 'private-password']) assert.ok(!JSON.stringify(report).includes(secret));
});

test('apply is atomic and repeatable; only named secrets and schedule are changed', async t => {
  const unrelated = { id: 'unrelated', name: 'other-app-token', description: 'do not touch', value: 'other-private-credential' };
  const f = await fixture(t, { state: { secrets: [unrelated] } });
  const report = await setupRecovery({ ...f.options, apply: true });
  assert.equal(report.schedule_enabled, true);
  assert.equal(report.replay_table_present, true);
  assert.deepEqual(f.db.state.secrets[0], unrelated);
  assert.equal(f.db.state.job.jobid, 17);
  assert.equal(f.db.state.job.command, JOB_COMMAND);
  const firstWrites = f.calls.filter(call => call.query?.startsWith('select vault.create_secret')).length;
  const again = await setupRecovery({ ...f.options, apply: true });
  assert.equal(again.schedule_enabled, true);
  assert.equal(f.db.state.secrets.length, 3);
  assert.equal(f.db.state.job.jobid, 17);
  assert.equal(f.calls.filter(call => call.query?.startsWith('select vault.create_secret')).length, firstWrites);
  for (const value of [TOKEN, DATABASE, 'other-private-credential']) assert.ok(!JSON.stringify(report).includes(value));
  const commandCalls = f.calls.filter(call => call.query?.startsWith('select cron.schedule'));
  assert.ok(commandCalls.every(call => call.params[2] === JOB_COMMAND && !call.params[2].includes(TOKEN)));
});

test('recreated host updates only the owned origin secret; stable token is reused', async t => {
  const f = await fixture(t);
  await setupRecovery({ ...f.options, apply: true });
  await writeFile(join(f.rootDir, '.blaxel/web-host.json'), JSON.stringify({ origin: 'https://new-app.example.test' }));
  const report = await setupRecovery({ ...f.options, apply: true });
  assert.equal(report.target_origin, 'https://new-app.example.test');
  assert.equal(f.db.state.secrets.find(row => row.name === SECRET_NAMES.origin).value, report.target_origin);
  assert.equal(f.db.state.secrets.find(row => row.name === SECRET_NAMES.token).value, TOKEN);
  const updates = f.calls.filter(call => call.query?.startsWith('select vault.update_secret'));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].params[2], SECRET_NAMES.origin);
});

test('unrelated secrets, functions, tables and schedules cannot be adopted', async t => {
  for (const state of [
    { secrets: [{ id: 'foreign', name: SECRET_NAMES.token, description: 'someone else', value: TOKEN }] },
    { objects: [{ proname: 'recovery_due', pronargs: 0, marker: 'someone else', owned: true }] },
    { nonces: [{ ...nonceRow(), marker: 'someone else' }] },
    { schemaOwned: false },
    { extensions: extensions().map(row => row.name === 'pg_cron' ? { ...row, installed_version: '1.6.4' } : row),
      job: { jobid: 4, username: 'postgres', command: 'select other_app();', active: true } },
  ]) {
    const f = await fixture(t, { state });
    await assert.rejects(setupRecovery({ ...f.options, apply: true }), error => /collision|not_owned/.test(error.code));
    assert.ok(f.calls.filter(call => call.type === 'begin').every(call => call.mode === 'read only'));
  }
});

test('missing schema and extension prerequisites fail before writes', async t => {
  for (const state of [
    { ready: false },
    { extensions: extensions().filter(row => row.name !== 'pg_net') },
    { extensions: extensions().map(row => row.name === 'supabase_vault' ? { ...row, installed_version: null } : row) },
  ]) {
    const f = await fixture(t, { state });
    await assert.rejects(setupRecovery({ ...f.options, apply: true }));
    assert.ok(f.calls.filter(call => call.type === 'begin').every(call => call.mode === 'read only'));
  }
});

test('failed setup rolls back extensions, Vault changes, nonce table and schedule together; errors are safe', async t => {
  const f = await fixture(t, { failDdl: true });
  const before = structuredClone(f.db.state);
  await assert.rejects(setupRecovery({ ...f.options, apply: true }), error => {
    const safe = JSON.stringify(safeError(error));
    assert.ok(!safe.includes(DATABASE)); assert.ok(!safe.includes(TOKEN)); return true;
  });
  assert.deepEqual(f.db.state, before);
  assert.ok(f.calls.some(call => call.type === 'rollback' && call.mode === ''));
  assert.ok(f.db.endCalls > 0);
});

test('CA validation reuses strict certificate parser and rejects SSL URL overrides before I/O', async t => {
  const pem = rootCertificates[0], encoded = Buffer.from(pem).toString('base64');
  const f = await fixture(t, { env: `${ENV}DATABASE_CA_CERT_BASE64=${encoded}\n` });
  const report = await setupRecovery(f.options);
  assert.deepEqual(f.dbOptions().ssl, { ca: pem, rejectUnauthorized: true });
  assert.ok(!JSON.stringify(report).includes(encoded));
  const providerUrl = await fixture(t, { env: `${ENV.replace(DATABASE, `${DATABASE}?sslmode=require`)}DATABASE_CA_CERT_BASE64=${encoded}\n` });
  await setupRecovery(providerUrl.options);
  assert.deepEqual(providerUrl.dbOptions().ssl, { ca: pem, rejectUnauthorized: true });
  for (const env of [`${ENV}DATABASE_CA_CERT_BASE64=bad!\n`, ENV.replace(DATABASE, `${DATABASE}?sslmode=disable`), ENV.replace(TOKEN, 'short')]) {
    const invalid = await fixture(t, { env });
    await assert.rejects(setupRecovery(invalid.options));
    assert.equal(invalid.calls.length, 0);
  }
});

test('origins are taken from active host or explicit override and must be clean HTTPS origins', async t => {
  for (const origin of ['http://app.example.test', 'https://user:secret@app.example.test', 'https://app.example.test/path', 'https://app.example.test?secret=value', 'https://app.example.test:444']) {
    const f = await fixture(t);
    await assert.rejects(setupRecovery({ ...f.options, origin }), { code: 'invalid_origin' });
    assert.equal(f.calls.length, 0);
  }
  const f = await fixture(t);
  await rm(join(f.rootDir, '.blaxel/web-host.json'));
  const report = await setupRecovery({ ...f.options, origin: ORIGIN });
  assert.equal(report.target_origin, ORIGIN);
});

test('missing private env and ambiguous CLI options fail safely; help requires no account', async t => {
  const f = await fixture(t, { env: '' });
  await assert.rejects(setupRecovery(f.options), { code: 'missing_configuration' });
  const help = spawnSync(process.execPath, ['scripts/setup-recovery.mjs', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /idle-aware/);
  const ambiguous = spawnSync(process.execPath, ['scripts/setup-recovery.mjs', '--plan', '--apply'], { encoding: 'utf8' });
  assert.equal(ambiguous.status, 1); assert.match(ambiguous.stderr, /invalid_options/);
});

test('scratch Postgres proves each due predicate and signed no-op/dispatch runtime', { skip: process.env.MEDIAPACK_TEST_LOCAL_POSTGRES !== '1' }, async t => {
  const pgBin = process.env.PG_BIN || '/opt/homebrew/opt/postgresql@17/bin';
  const data = await mkdtemp(join(tmpdir(), 'mediapack-recovery-pg-'));
  const port = 55439;
  const command = (name, args) => {
    const result = spawnSync(join(pgBin, name), args, { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, `${name} failed: ${result.stderr?.slice(0, 600)}`);
    return result;
  };
  command('initdb', ['-D', data, '-U', 'postgres', '-A', 'trust']);
  command('pg_ctl', ['-D', data, '-o', `-p ${port} -k ${data} -h 127.0.0.1`, '-l', join(data, 'log'), 'start', '-w']);
  t.after(() => { spawnSync(join(pgBin, 'pg_ctl'), ['-D', data, 'stop', '-m', 'immediate'], { timeout: 10000 }); });
  const require = createRequire(resolve('apps/mediapack/package.json'));
  const sql = require('postgres')({ host: '127.0.0.1', port, database: 'postgres', user: 'postgres', max: 1, onnotice: () => {} });
  t.after(() => sql.end({ timeout: 1 }));
  await sql.unsafe('create role anon; create role authenticated; create role service_role');
  await sql.unsafe(await readFile('supabase/migrations/0001_init.sql', 'utf8'));
  await sql.unsafe(`create schema mediapack_setup; create schema vault; create schema net;
    create table vault.decrypted_secrets (name text, decrypted_secret text);
    create table net.requests (id bigint generated always as identity, url text, headers jsonb, timeout_ms int);
    create function net.http_post(url text, body jsonb, headers jsonb, timeout_milliseconds int) returns bigint language sql as $$
      insert into net.requests(url,headers,timeout_ms) values(url,headers,timeout_milliseconds) returning id;
    $$;`);
  await sql.unsafe('insert into vault.decrypted_secrets values ($1,$2),($3,$4)', [SECRET_NAMES.origin, ORIGIN, SECRET_NAMES.token, TOKEN]);
  await sql.unsafe(schedulerSql('public'));
  const client = '11111111-1111-4111-8111-111111111111', video = '22222222-2222-4222-8222-222222222222';
  const quote = '33333333-3333-4333-8333-333333333333', job = '44444444-4444-4444-8444-444444444444';
  async function reset() {
    await sql.unsafe('truncate public.clients, public.provider_events, public.outbox, net.requests cascade');
    await sql.unsafe("insert into public.clients(id,capability_hash,expires_at) values ($1,'synthetic-hash',now()+interval '1 day')", [client]);
    await sql.unsafe(`insert into public.videos(id,client_id,original_filename,object_key,declared_size_bytes,upload_expires_at)
        values($2,$1,'synthetic.mp4','synthetic/source.mp4',1,now()+interval '1 hour');`, [client, video]);
  }
  async function createJob({ paid = false, pack = "now()+interval '1 hour'", state = 'awaiting_payment', quoteExpiry = "now()+interval '1 hour'" } = {}) {
    await sql.unsafe(`insert into public.quotes(id,video_id,source_sha256,amount_minor,currency,payment_mode,limit_searches,limit_frames,limit_clip_ms,limit_text_chars,pack_ttl_seconds,indexer_version,terms_hash,expires_at)
      values($1,$2,'synthetic',50,'usd','test',1,1,1000,100,86400,'test','synthetic',${quoteExpiry});`, [quote, video]);
    await sql.unsafe(`insert into public.jobs(id,quote_id,video_id,client_id,state,paid_at,pack_expires_at)
      values($1,$2,$3,$4,$5,${paid ? 'now()' : 'null'},${pack});`, [job, quote, video, client, state]);
  }
  async function expected(reason) {
    const [result] = await sql.unsafe(DUE_SQL);
    assert.deepEqual(result, { ...EMPTY_DUE, ...(reason ? { [reason]: true } : {}) });
    const [actual] = await sql.unsafe('select mediapack_setup.recovery_due() as due');
    assert.equal(actual.due, !!reason);
  }
  await reset(); await expected(null);
  assert.equal((await sql.unsafe('select mediapack_setup.dispatch_recovery_tick() as request_id'))[0].request_id, null);
  assert.equal((await sql.unsafe('select count(*)::int as n from net.requests'))[0].n, 0);

  // Outbox eligibility respects both retry time and send lease.
  await sql.unsafe("insert into public.outbox(logical_key,target,action,payload,payload_hash,idempotency_key,next_attempt_at) values('test','primitive','probe_video','{}','hash','idem',now()+interval '1 minute')");
  await expected(null);
  await sql.unsafe("update public.outbox set next_attempt_at=now(),lease_expires_at=now()+interval '1 minute'"); await expected(null);
  await sql.unsafe("update public.outbox set lease_expires_at=now()-interval '1 second'"); await expected('due_outbox');
  const [{ request_id: requestId }] = await sql.unsafe('select mediapack_setup.dispatch_recovery_tick() as request_id');
  assert.ok(requestId);
  const [request] = await sql.unsafe('select * from net.requests where id=$1', [requestId]);
  assert.equal(request.url, `${ORIGIN}/internal/tick`); assert.equal(request.timeout_ms, 55000);
  assert.ok(!JSON.stringify(request.headers).includes(TOKEN)); assert.ok(!request.headers.authorization);
  const stamp = request.headers['x-mediapack-tick-timestamp'], nonce = request.headers['x-mediapack-tick-nonce'];
  assert.match(nonce, /^[0-9a-f-]{36}$/);
  assert.equal(request.headers['x-mediapack-tick-signature'], createHmac('sha256', TOKEN).update(`mediapack-tick-v1\n${stamp}\n${nonce}`).digest('hex'));
  await sql.unsafe('update public.outbox set sent_at=now()'); await expected(null);

  await reset();
  await sql.unsafe("insert into public.operations(video_id,kind,request_id,input_hash,state,lease_expires_at) values($1,'probe_video',gen_random_uuid(),'hash','running',now()+interval '1 minute')", [video]); await expected(null);
  await sql.unsafe("update public.operations set lease_expires_at=now()-interval '1 second'"); await expected('stale_operations');
  await sql.unsafe("update public.operations set state='succeeded'"); await expected(null);

  await reset();
  await sql.unsafe("insert into public.provider_events(provider,event_id,kind,received_at) values('primitive','synthetic-event','email.received',now())"); await expected(null);
  await sql.unsafe("update public.provider_events set received_at=now()-interval '31 seconds'"); await expected('pending_primitive_events');
  await sql.unsafe("update public.provider_events set state='error',payload='{\"attempts\":5}'"); await expected(null);
  await sql.unsafe("update public.provider_events set payload='{\"attempts\":4}'"); await expected('pending_primitive_events');
  await sql.unsafe("update public.provider_events set state='applied'"); await expected(null);

  await reset(); await createJob();
  await sql.unsafe("insert into public.payment_attempts(job_id,state,terms_hash,source) values($1,'unknown','hash','mpp')", [job]); await expected(null);
  await sql.unsafe("update public.payment_attempts set updated_at=now()-interval '61 seconds'"); await expected('pending_payments');
  await sql.unsafe("update public.payment_attempts set state='failed'"); await expected(null);

  for (const state of ['uploading', 'probing', 'ready']) {
    await reset(); await sql.unsafe("update public.videos set state=$1,upload_expires_at=now()-interval '1 second'", [state]); await expected('expired_uploads');
  }
  await reset(); await createJob();
  await sql.unsafe("update public.videos set upload_expires_at=now()-interval '1 second'"); await expected(null); // live quote protects upload
  await reset(); await createJob({ quoteExpiry: "now()-interval '1 minute'" });
  await sql.unsafe("update public.videos set upload_expires_at=now()-interval '1 second'"); await expected('expired_uploads');
  for (const state of ['submitting', 'unknown', 'succeeded']) {
    await sql.unsafe('delete from public.payment_attempts');
    await sql.unsafe('insert into public.payment_attempts(job_id,state,terms_hash,source) values($1,$2,\'hash\',\'mpp\')', [job, state]); await expected(null); // payment outcome protects upload
  }
  await reset(); await createJob({ paid: true, quoteExpiry: "now()-interval '1 minute'" });
  await sql.unsafe("update public.videos set upload_expires_at=now()-interval '1 second'"); await expected(null); // paid media is retained

  for (const state of ['ready', 'paid', 'indexing']) {
    await reset(); await createJob({ paid: true, pack: "now()-interval '1 second'", state }); await expected('expired_packs');
  }
  await reset(); await createJob({ paid: true, pack: "now()-interval '1 second'", state: 'expired' }); await expected(null);
  await reset(); await createJob({ paid: false, pack: "now()-interval '1 second'", state: 'ready' }); await expected(null);

  // The helper's private functions confer no elevated rights and cannot be invoked by browser roles.
  const [security] = await sql.unsafe(`select bool_and(not prosecdef) as invoker,
    bool_and(not has_function_privilege('anon',p.oid,'execute') and not has_function_privilege('authenticated',p.oid,'execute')) as private
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='mediapack_setup'`);
  assert.deepEqual(security, { invoker: true, private: true });
});
