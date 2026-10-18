#!/usr/bin/env node
// Durable recovery checks execute inside Supabase; idle databases never ping Blaxel.
import { parseArgs, parseEnv } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { databaseSsl } from './setup-supabase.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(resolve(ROOT, 'apps/mediapack/package.json'));
export const JOB_NAME = 'mediapack-recovery-v1';
export const JOB_COMMAND = 'select mediapack_setup.dispatch_recovery_tick();';
export const OWNER = 'MediaPack recovery scheduler v1; managed by scripts/setup-recovery.mjs';
export const SECRET_NAMES = Object.freeze({ origin: 'mediapack_recovery_origin_v1', token: 'mediapack_recovery_tick_token_v1' });
const LOCK = 1297109844;

// These are the exact eligibility conditions in system.ts, videos.ts, inbox.ts,
// payments.ts and claim_outbox_batch/reap_stale_operations in 0001_init.sql.
// A quoted video, a running worker with a valid lease, or a future retry is idle.
export const DUE_SQL = `select
  exists (select 1 from public.operations where state = 'running' and lease_expires_at < now()) as stale_operations,
  exists (select 1 from public.videos v
    where v.state in ('uploading','probing','ready') and v.upload_expires_at < now()
      and not exists (select 1 from public.jobs j join public.quotes q on q.id = j.quote_id
        where j.video_id = v.id and (j.paid_at is not null or q.expires_at > now()
          or exists (select 1 from public.payment_attempts a where a.job_id = j.id
            and a.state in ('submitting','unknown','succeeded'))))) as expired_uploads,
  exists (select 1 from public.jobs where paid_at is not null and pack_expires_at < now()
    and state in ('ready','paid','indexing')) as expired_packs,
  exists (select 1 from public.provider_events
    where provider = 'primitive' and kind = 'email.received' and state in ('received','error')
      and received_at < now() - interval '30 seconds' and coalesce((payload->>'attempts')::int, 0) < 5) as pending_primitive_events,
  exists (select 1 from public.payment_attempts pa join public.jobs j on j.id = pa.job_id
    where pa.state in ('submitting','unknown') and pa.updated_at < now() - interval '60 seconds') as pending_payments,
  exists (select 1 from public.outbox where sent_at is null and next_attempt_at <= now()
    and (lease_expires_at is null or lease_expires_at < now())) as due_outbox`;

export class RecoveryError extends Error {
  constructor(code, message, action) { super(message); this.code = code; this.next_action = action; }
}
const fail = (code, message, action) => { throw new RecoveryError(code, message, action); };
export function safeError(error) {
  return error instanceof RecoveryError || error?.code === 'invalid_database_ca'
    ? { error: error.code, hint: error.message, next_action: error.next_action }
    : { error: 'recovery_setup_failed', hint: 'Recovery setup did not complete; private database and provider details were withheld.',
      next_action: 'Check verified database access, extension permissions and the deployed tick signature handler, then rerun --plan.' };
}

function originValue(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !/^[a-z0-9.-]+$/i.test(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.port) throw new Error();
    return url.origin;
  } catch { fail('invalid_origin', 'The recovery target must be an HTTPS origin without credentials, path, port, query or fragment.',
    'Use the active .blaxel/web-host.json origin, or pass --origin https://your-current-host.'); }
}

function identifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) fail('unsupported_extension_schema', 'The pgcrypto extension schema is unsupported.', 'Inspect the existing extension namespace before setup.');
  return `"${value}"`;
}

export function schedulerSql(cryptoSchema = 'extensions') {
  const crypto = identifier(cryptoSchema);
  return `create or replace function mediapack_setup.recovery_due() returns boolean
    language sql stable security invoker set search_path = pg_catalog as $mp_due$
      select stale_operations or expired_uploads or expired_packs or pending_primitive_events or pending_payments or due_outbox
      from (${DUE_SQL}) as reasons;
    $mp_due$;
    comment on function mediapack_setup.recovery_due() is '${OWNER}';
    revoke all on function mediapack_setup.recovery_due() from public, anon, authenticated, service_role;
    create or replace function mediapack_setup.dispatch_recovery_tick() returns bigint
    language plpgsql security invoker set search_path = pg_catalog as $mp_dispatch$
    declare target_origin text; tick_token text; stamp text; nonce text; signature text;
    begin
      if not pg_try_advisory_xact_lock(${LOCK}) then return null; end if;
      if not mediapack_setup.recovery_due() then return null; end if;
      select decrypted_secret into strict target_origin from vault.decrypted_secrets where name = '${SECRET_NAMES.origin}';
      select decrypted_secret into strict tick_token from vault.decrypted_secrets where name = '${SECRET_NAMES.token}';
      if target_origin !~ '^https://[A-Za-z0-9.-]+$' or length(tick_token) < 32 then
        raise exception 'MediaPack recovery settings are invalid; rerun setup-recovery --apply';
      end if;
      stamp := floor(extract(epoch from clock_timestamp()))::bigint::text;
      nonce := gen_random_uuid()::text;
      signature := encode(${crypto}.hmac(convert_to('mediapack-tick-v1' || chr(10) || stamp || chr(10) || nonce, 'UTF8'),
        convert_to(tick_token, 'UTF8'), 'sha256'), 'hex');
      return net.http_post(url := target_origin || '/internal/tick', body := '{}'::jsonb,
        headers := jsonb_build_object('Content-Type', 'application/json',
          'x-mediapack-tick-timestamp', stamp, 'x-mediapack-tick-nonce', nonce, 'x-mediapack-tick-signature', signature),
        timeout_milliseconds := 55000);
    end $mp_dispatch$;
    comment on function mediapack_setup.dispatch_recovery_tick() is '${OWNER}';
    revoke all on function mediapack_setup.dispatch_recovery_tick() from public, anon, authenticated, service_role;`;
}

const NONCES_SQL = `create table mediapack_setup.recovery_nonces (
  nonce uuid primary key, expires_at timestamptz not null);
  comment on table mediapack_setup.recovery_nonces is '${OWNER}';
  create index recovery_nonces_expires_idx on mediapack_setup.recovery_nonces (expires_at);`;

async function transaction(sql, readOnly, run) {
  return sql.begin(readOnly ? 'read only' : '', async tx => {
    await tx.unsafe("set local search_path = pg_catalog; set local statement_timeout = '30s'; set local lock_timeout = '5s'; set local idle_in_transaction_session_timeout = '15s'");
    await tx.unsafe('select pg_catalog.pg_advisory_xact_lock($1)', [LOCK]);
    return run(tx);
  });
}

async function inspect(tx) {
  const [{ ready }] = await tx.unsafe(`select to_regclass('mediapack_setup.migrations') is not null
    and to_regclass('public.operations') is not null and to_regclass('public.videos') is not null
    and to_regclass('public.jobs') is not null and to_regclass('public.quotes') is not null
    and to_regclass('public.payment_attempts') is not null and to_regclass('public.provider_events') is not null
    and to_regclass('public.outbox') is not null as ready`);
  if (!ready) fail('database_not_initialized', 'The MediaPack database is not fully initialized.', 'Apply the checksummed app migrations with scripts/setup-supabase.mjs first.');
  const [{ owned: privateSchemaOwned }] = await tx.unsafe("select nspowner = (select oid from pg_roles where rolname = current_user) as owned from pg_namespace where nspname = 'mediapack_setup'");
  if (!privateSchemaOwned) fail('private_schema_not_owned', 'The setup schema is owned by another database role.', 'Use the migration-owner database connection to configure private recovery infrastructure.');
  const extensions = await tx.unsafe(`select a.name, a.default_version, a.installed_version, n.nspname as schema
    from pg_available_extensions a left join pg_extension e on e.extname = a.name
    left join pg_namespace n on n.oid = e.extnamespace
    where a.name in ('pg_cron','pg_net','supabase_vault','pgcrypto') order by a.name`);
  if (['pg_cron', 'pg_net', 'supabase_vault', 'pgcrypto'].some(name => !extensions.some(row => row.name === name))) {
    fail('extensions_unavailable', 'The database does not offer all required scheduler extensions.', 'Use a supported Supabase project; this helper never substitutes paid infrastructure.');
  }
  if (extensions.some(row => ['supabase_vault', 'pgcrypto'].includes(row.name) && !row.installed_version)) {
    fail('vault_or_crypto_missing', 'Supabase Vault and pgcrypto must already be enabled.', 'Enable the official Supabase Vault and pgcrypto extensions, then rerun --plan.');
  }
  const [{ current_user: username }] = await tx.unsafe('select current_user');
  const objects = await tx.unsafe(`select p.proname, p.pronargs, obj_description(p.oid, 'pg_proc') as marker,
    pg_get_userbyid(p.proowner) = current_user as owned from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'mediapack_setup' and p.proname in ('recovery_due','dispatch_recovery_tick')`);
  if (objects.some(row => row.marker !== OWNER || !row.owned || row.pronargs !== 0)) {
    fail('scheduler_name_collision', 'A recovery function name is already owned by another setup.', 'Preserve the existing function and resolve the name collision before rerunning this helper.');
  }
  const nonces = await tx.unsafe(`select obj_description(c.oid, 'pg_class') as marker,
    pg_get_userbyid(c.relowner) = current_user as owned, c.relrowsecurity as rls,
    (select array_agg(a.attname::text || ':' || format_type(a.atttypid, a.atttypmod) order by a.attnum)
      from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as columns,
    exists (select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attname = 'expires_at'
      where i.indrelid = c.oid and i.indkey[0] = a.attnum and i.indisvalid) as expiry_index
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'mediapack_setup' and c.relname = 'recovery_nonces'`);
  if (nonces.some(row => row.marker !== OWNER || !row.owned || JSON.stringify(row.columns) !== JSON.stringify(['nonce:uuid', 'expires_at:timestamp with time zone']) || !row.expiry_index)) {
    fail('nonce_table_collision', 'The recovery nonce table differs from the owned infrastructure contract.', 'Preserve the existing table and inspect its owner, marker, columns and expiry index before setup.');
  }
  const secrets = await tx.unsafe('select id, name, description from vault.secrets where name = any($1::text[])', [Object.values(SECRET_NAMES)]);
  if (secrets.some(row => row.description !== OWNER)) {
    fail('secret_name_collision', 'A recovery Vault secret name is already owned by another setup.', 'Preserve the existing secret and resolve the name collision before rerunning this helper.');
  }
  let job = null;
  if (extensions.find(row => row.name === 'pg_cron').installed_version) {
    const jobs = await tx.unsafe('select jobid, username, command, schedule, active from cron.job where jobname = $1', [JOB_NAME]);
    if (jobs.length > 1 || jobs.some(row => row.username !== username || row.command !== JOB_COMMAND)) {
      fail('cron_name_collision', 'The recovery schedule name is already used by another command or owner.', 'Preserve the unrelated schedule and resolve the name collision before setup.');
    }
    job = jobs[0] ?? null;
  }
  const [due] = await tx.unsafe(DUE_SQL);
  return { extensions, objects, nonces, secrets, job, due, cryptoSchema: extensions.find(row => row.name === 'pgcrypto').schema };
}

async function writeSecrets(tx, state, values) {
  for (const [key, name] of Object.entries(SECRET_NAMES)) {
    const row = state.secrets.find(secret => secret.name === name);
    if (row) {
      // Comparison occurs in the database; a decrypted secret is never returned to this process.
      const [{ matches }] = await tx.unsafe('select decrypted_secret = $1 as matches from vault.decrypted_secrets where id = $2::uuid', [values[key], row.id]);
      if (!matches) await tx.unsafe('select vault.update_secret($1::uuid, $2, $3, $4)', [row.id, values[key], name, OWNER]);
    } else await tx.unsafe('select vault.create_secret($1, $2, $3)', [values[key], name, OWNER]);
  }
}

export async function setupRecovery({ rootDir = ROOT, envFile = 'apps/web/.env.blaxel', origin, apply = false,
  postgresFactory, timeoutMs = 90_000 } = {}) {
  let env;
  try { env = parseEnv(await readFile(resolve(rootDir, envFile), 'utf8')); }
  catch { fail('env_unavailable', 'The private recovery settings file could not be read.', 'Save DATABASE_URL and INTERNAL_TICK_TOKEN in the --env-file path.'); }
  if (!env.DATABASE_URL?.trim() || !env.INTERNAL_TICK_TOKEN?.trim()) fail('missing_configuration', 'DATABASE_URL and INTERNAL_TICK_TOKEN are required.', 'Save the actual database connection and stable tick token privately, then run --plan.');
  if (env.INTERNAL_TICK_TOKEN.length < 32 || /[\r\n]/.test(env.INTERNAL_TICK_TOKEN)) fail('invalid_tick_token', 'INTERNAL_TICK_TOKEN must be at least 32 characters without line breaks.', 'Keep the same strong tick token in the hosted app and the private setup file.');
  try {
    const db = new URL(env.DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(db.protocol) || !db.hostname || !db.pathname || [...db.searchParams.keys()].some(key =>
      /^(ssl|sslrootcert|sslcert|sslkey)$/i.test(key) || /^sslmode$/i.test(key) && !['require', 'verify-ca', 'verify-full'].includes(db.searchParams.get(key)))) throw new Error();
  } catch { fail('invalid_database_url', 'DATABASE_URL must be a Postgres URL without insecure SSL options.', 'Use the provider connection URL and DATABASE_CA_CERT_BASE64; strict certificate verification is required.'); }
  if (!origin) {
    try { origin = JSON.parse(await readFile(resolve(rootDir, '.blaxel/web-host.json'), 'utf8')).origin; }
    catch { fail('host_unavailable', 'The active Blaxel host origin could not be read.', 'Create the current host first, or pass its HTTPS origin with --origin.'); }
  }
  const targetOrigin = originValue(origin);
  const ssl = databaseSsl(env.DATABASE_CA_CERT_BASE64);
  const sql = (postgresFactory ?? require('postgres'))(env.DATABASE_URL, { max: 1, prepare: false, ssl,
    connect_timeout: 10, idle_timeout: 5, onnotice: () => {},
    connection: { application_name: 'mediapack-recovery-setup', statement_timeout: 30000, lock_timeout: 5000 } });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void sql.end({ timeout: 0 }).catch(() => {}); }, timeoutMs);
  try {
    const initial = await transaction(sql, true, inspect);
    let final = initial;
    if (apply) {
      await transaction(sql, false, async tx => {
        const state = await inspect(tx); // Check ownership again under the same transaction lock.
        if (!state.extensions.find(row => row.name === 'pg_cron').installed_version) await tx.unsafe('create extension pg_cron with schema pg_catalog');
        if (!state.extensions.find(row => row.name === 'pg_net').installed_version) await tx.unsafe('create extension pg_net with schema extensions');
        await tx.unsafe('revoke all on schema mediapack_setup from public, anon, authenticated, service_role');
        if (!state.nonces.length) await tx.unsafe(NONCES_SQL);
        await tx.unsafe('revoke all on table mediapack_setup.recovery_nonces from public, anon, authenticated, service_role; alter table mediapack_setup.recovery_nonces enable row level security');
        await writeSecrets(tx, state, { origin: targetOrigin, token: env.INTERNAL_TICK_TOKEN });
        await tx.unsafe(schedulerSql(state.cryptoSchema));
        await tx.unsafe('select cron.schedule($1, $2, $3)', [JOB_NAME, '* * * * *', JOB_COMMAND]);
        await tx.unsafe('select cron.alter_job($1, active := true)', [(await tx.unsafe('select jobid from cron.job where jobname = $1', [JOB_NAME]))[0].jobid]);
      });
      final = await transaction(sql, true, inspect);
      if (!final.job?.active || final.job.schedule !== '* * * * *' || final.objects.length !== 2 || final.secrets.length !== 2 || !final.nonces[0]?.rls) {
        fail('scheduler_readback_failed', 'Scheduler configuration did not pass readback.', 'Inspect only the MediaPack-owned schedule and functions, then rerun --plan.');
      }
    }
    return { mode: apply ? 'apply' : 'plan', target_origin: targetOrigin, schedule: '* * * * *', job_name: JOB_NAME,
      schedule_enabled: final.job?.active === true, extensions: final.extensions,
      replay_table_present: final.nonces.length === 1,
      extensions_to_enable: final.extensions.filter(row => !row.installed_version).map(row => row.name),
      recovery_due: Object.values(final.due).some(Boolean), due_reasons: final.due,
      permanent_token_in_http_queue: false, idle_http_requests: 0,
      next_action: apply ? 'Verify a due recovery and an idle no-op, then rerun --apply whenever the host origin or tick token changes.'
        : 'After hosted provider credentials and signed tick authentication are verified, run --apply. This plan never wakes Blaxel or sends provider requests.' };
  } catch (error) {
    if (error instanceof RecoveryError) throw error;
    if (timedOut) fail('setup_timeout', 'Recovery setup exceeded its deadline.', 'Check database connectivity and rerun --plan before applying again.');
    throw error;
  } finally { clearTimeout(timer); await sql.end({ timeout: 1 }).catch(() => {}); }
}

async function main() {
  let values;
  try { ({ values } = parseArgs({ options: { plan: { type: 'boolean' }, apply: { type: 'boolean' },
    'env-file': { type: 'string', default: 'apps/web/.env.blaxel' }, origin: { type: 'string' }, help: { type: 'boolean', short: 'h' } } })); }
  catch { fail('invalid_options', 'Unsupported or incomplete recovery options.', 'Run node scripts/setup-recovery.mjs --help.'); }
  if (values.help) {
    console.log('Usage: node scripts/setup-recovery.mjs [--plan | --apply] [--env-file PATH] [--origin HTTPS_ORIGIN]\nDefault --plan reads Supabase metadata and due-work predicates only. --apply enables pg_cron/pg_net, stores the stable tick token and active Blaxel origin in Vault, and installs one private idle-aware schedule. The hosted tick route must support signed scheduler requests. No provider mail, models or payments are called by setup. Never changes a billing plan.');
    return;
  }
  if (values.plan && values.apply) fail('invalid_options', 'Choose either --plan or --apply.', 'Use --plan to inspect or --apply to install the reviewed schedule.');
  console.log(JSON.stringify(await setupRecovery({ apply: values.apply, envFile: values['env-file'], origin: values.origin }), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(JSON.stringify(safeError(error))); process.exitCode = 1; });
}
