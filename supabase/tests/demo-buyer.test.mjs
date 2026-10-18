// Run only through scripts/test-demo-buyer-db.sh, which owns a disposable server.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { after, beforeEach, test } from 'node:test';

const require = createRequire(new URL('../../apps/mediapack/package.json', import.meta.url));
const postgres = require('postgres');
const socket = process.env.MEDIAPACK_DEMO_TEST_SOCKET;
assert.ok(socket?.includes('/mediapack-demo-db.'), 'Use scripts/test-demo-buyer-db.sh; never run against an application database.');
const options = { host: socket, port: Number(process.env.MEDIAPACK_DEMO_TEST_PORT), username: 'postgres', database: 'postgres', max: 1, prepare: false, connect_timeout: 5, idle_timeout: 5 };
const sql = postgres(options);
const connections = [sql];
const connect = () => { const connection = postgres(options); connections.push(connection); return connection; };
after(async () => { await Promise.all(connections.map((connection) => connection.end({ timeout: 2 }))); });
beforeEach(async () => { await sql`truncate clients cascade`; });

async function fixture({ clientId, amount = 50, currency = 'usd', mode = 'test', state = 'ready', sha = 'verified-sha', quoteSha = sha, expiresAt = new Date(Date.now() + 60_000) } = {}) {
  const client = clientId ?? randomUUID();
  if (!clientId) await sql`insert into clients (id, capability_hash, expires_at) values (${client}, ${randomUUID()}, now() + interval '48 hours')`;
  const video = randomUUID(), quote = randomUUID(), job = randomUUID();
  await sql`insert into videos (id, client_id, original_filename, object_key, declared_size_bytes, size_bytes, sha256, duration_ms, width, height, audio, state, upload_expires_at)
    values (${video}, ${client}, 'test.mp4', ${`${video}/source.mp4`}, 100, 100, ${sha}, 1000, 320, 240, 'absent', ${state}, now() + interval '1 hour')`;
  await sql`insert into quotes (id, video_id, source_sha256, amount_minor, currency, payment_mode, limit_searches, limit_frames, limit_clip_ms, limit_text_chars, pack_ttl_seconds, indexer_version, terms_hash, expires_at)
    values (${quote}, ${video}, ${quoteSha}, ${amount}, ${currency}, ${mode}, 3, 8, 15000, 8000, 86400, 'video-index-v1', 'test-terms', ${expiresAt})`;
  await sql`insert into jobs (id, quote_id, video_id, client_id) values (${job}, ${quote}, ${video}, ${client})`;
  return { client, video, quote, job };
}
async function reserve(f, perClient = 2, global = 100, connection = sql) {
  const [row] = await connection`select * from reserve_demo_purchase(${f.client}, ${f.job}, ${perClient}, ${global})`;
  return { ...row };
}
const hasError = (prefix) => (error) => error.code === 'P0001' && error.message.startsWith(prefix);

// Hold the exact database advisory lock until both independent backend sessions
// are waiting for it, then release them together. This exercises an actual race.
async function raceReservations(a, b, globalLimit) {
  const first = connect(), second = connect(), blocker = connect();
  const [{ pid: firstPid }] = await first`select pg_backend_pid() as pid`;
  const [{ pid: secondPid }] = await second`select pg_backend_pid() as pid`;
  assert.notEqual(firstPid, secondPid);
  let requestA, requestB;
  await blocker.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended('mediapack:demo-buyer:reservation:v1', 0))`;
    requestA = reserve(a, 2, globalLimit, first);
    requestB = reserve(b, 2, globalLimit, second);
    let waiting = 0;
    for (let attempt = 0; attempt < 100; attempt++) {
      const [row] = await tx`select count(*)::int as waiting from pg_stat_activity
        where pid in (${firstPid}, ${secondPid}) and wait_event_type = 'Lock' and wait_event = 'advisory'`;
      waiting = row.waiting;
      if (waiting === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(waiting, 2, 'both independent connections must reach the lock concurrently');
  });
  return Promise.all([requestA, requestB]);
}

test('reservation is durable, scoped to quote/job/client, and restricted to server roles', async () => {
  const f = await fixture();
  assert.deepEqual(await reserve(f), { outcome: 'reserved', reservation_state: 'reserved' });
  const [stored] = await sql`select * from demo_purchases`;
  assert.equal(stored.quote_id, f.quote);
  assert.equal(stored.job_id, f.job);
  assert.equal(stored.client_id, f.client);
  const [rights] = await sql`select
    (select relrowsecurity from pg_class where oid = 'demo_purchases'::regclass) as rls,
    has_table_privilege('anon', 'demo_purchases', 'SELECT') as anon_read,
    has_table_privilege('authenticated', 'demo_purchases', 'INSERT') as authenticated_insert,
    has_table_privilege('service_role', 'demo_purchases', 'SELECT,INSERT,UPDATE') as server_write,
    has_table_privilege('service_role', 'demo_purchases', 'DELETE') as server_delete,
    has_function_privilege('anon', 'reserve_demo_purchase(uuid,uuid,int,int)', 'EXECUTE') as anon_reserve,
    has_function_privilege('authenticated', 'mark_demo_purchase(uuid,text)', 'EXECUTE') as authenticated_mark,
    has_function_privilege('service_role', 'reserve_demo_purchase(uuid,uuid,int,int)', 'EXECUTE') as server_reserve`;
  assert.deepEqual({ ...rights }, { rls: true, anon_read: false, authenticated_insert: false, server_write: true, server_delete: false, anon_reserve: false, authenticated_mark: false, server_reserve: true });
});

test('two independent sessions cannot reserve the same quote twice', async () => {
  const f = await fixture();
  const outcomes = await raceReservations(f, f, 100);
  assert.deepEqual(outcomes.map((row) => row.outcome).sort(), ['existing', 'reserved']);
  assert.equal((await sql`select count(*)::int as n from demo_purchases`)[0].n, 1);
});

test('two independent sessions racing different clients cannot exceed the global cap', async () => {
  const outcomes = await raceReservations(await fixture(), await fixture(), 1);
  assert.deepEqual(outcomes.map((row) => row.outcome).sort(), ['limited', 'reserved']);
  assert.equal(outcomes.find((row) => row.outcome === 'limited').reservation_state, 'global_limit');
  assert.equal((await sql`select count(*)::int as n from demo_purchases`)[0].n, 1);
});

test('rolling client quota counts failed/unknown reservations and never merchant attempts', async () => {
  const first = await fixture();
  const second = await fixture({ clientId: first.client });
  const third = await fixture({ clientId: first.client });
  for (const f of [first, second, third]) {
    await sql`insert into payment_attempts (job_id, state, terms_hash, source) values (${f.job}, 'failed', 'test-terms', 'mpp')`;
  }
  assert.equal((await reserve(first)).outcome, 'reserved');
  await sql`select mark_demo_purchase(${first.quote}, 'failed')`;
  assert.equal((await reserve(second)).outcome, 'reserved');
  await sql`select mark_demo_purchase(${second.quote}, 'unknown')`;
  assert.deepEqual(await reserve(third), { outcome: 'limited', reservation_state: 'client_limit' });
  await sql`update demo_purchases set created_at = now() - interval '25 hours' where quote_id = ${first.quote}`;
  assert.equal((await reserve(third)).outcome, 'reserved');
  assert.deepEqual(await reserve(first), { outcome: 'existing', reservation_state: 'failed' });
});

test('ownership, active clients, quote terms, verified media, and limit arguments are enforced', async () => {
  const own = await fixture(), other = await fixture();
  await assert.rejects(reserve({ ...own, client: other.client }), hasError('UNAUTHORIZED'));
  await sql`update clients set revoked = true where id = ${own.client}`;
  await assert.rejects(reserve(own), hasError('UNAUTHORIZED'));
  await sql`update clients set revoked = false, expires_at = now() - interval '1 second' where id = ${own.client}`;
  await assert.rejects(reserve(own), hasError('UNAUTHORIZED'));
  for (const options of [{ amount: 100 }, { currency: 'eur' }, { mode: 'live' }]) {
    await assert.rejects(reserve(await fixture(options)), hasError('BAD_REQUEST'));
  }
  for (const options of [{ state: 'probing' }, { quoteSha: 'wrong-sha' }]) {
    await assert.rejects(reserve(await fixture(options)), hasError('VIDEO_NOT_READY'));
  }
  await assert.rejects(reserve(await fixture({ expiresAt: new Date(Date.now() - 1000) })), hasError('QUOTE_EXPIRED'));
  for (const limits of [[0, 100], [3, 100], [2, 101], [2, 0], [null, 100], [2, null]]) {
    await assert.rejects(reserve(other, ...limits), hasError('BAD_REQUEST'));
  }
  assert.equal((await sql`select count(*)::int as n from demo_purchases`)[0].n, 0);
});

test('paid and reconciling merchant jobs return their state without consuming demo quota', async () => {
  const paid = await fixture(), pending = await fixture();
  await sql`update jobs set paid_at = now(), state = 'indexing', payment_intent_id = 'pi_test_existing' where id = ${paid.job}`;
  await sql`insert into payment_attempts (job_id, state, terms_hash, source) values (${pending.job}, 'unknown', 'test-terms', 'mpp')`;
  assert.deepEqual(await reserve(paid), { outcome: 'existing', reservation_state: 'paid' });
  assert.deepEqual(await reserve(pending), { outcome: 'existing', reservation_state: 'reconciling' });
  assert.equal((await sql`select count(*)::int as n from demo_purchases`)[0].n, 0);
});

test('state markers are idempotent and cannot reopen failed, succeeded, or uncertain minting', async () => {
  const f = await fixture();
  await reserve(f);
  await sql`select mark_demo_purchase(${f.quote}, 'token_issued')`;
  await sql`select mark_demo_purchase(${f.quote}, 'token_issued')`;
  await sql`select mark_demo_purchase(${f.quote}, 'unknown')`;
  await assert.rejects(sql`select mark_demo_purchase(${f.quote}, 'token_issued')`, hasError('IDEMPOTENCY_CONFLICT'));
  await sql`select mark_demo_purchase(${f.quote}, 'succeeded')`;
  await sql`select mark_demo_purchase(${f.quote}, 'succeeded')`;
  await assert.rejects(sql`select mark_demo_purchase(${f.quote}, 'failed')`, hasError('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(sql`select mark_demo_purchase(${f.quote}, 'reserved')`, hasError('BAD_REQUEST'));
  await assert.rejects(sql`select mark_demo_purchase(${randomUUID()}, 'unknown')`, hasError('NOT_FOUND'));
  assert.deepEqual(await reserve(f), { outcome: 'existing', reservation_state: 'succeeded' });
});

test('a consumed quote stays consumed after quote expiry and a new database connection', async () => {
  const f = await fixture({ expiresAt: new Date(Date.now() + 400) });
  await reserve(f);
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.deepEqual(await reserve(f, 2, 100, connect()), { outcome: 'existing', reservation_state: 'reserved' });
});
