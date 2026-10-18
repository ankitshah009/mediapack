#!/usr/bin/env node
// Initialize an already-provisioned project; account creation belongs to Stripe Projects.
import { parseArgs, parseEnv } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(resolve(ROOT, 'apps/mediapack/package.json'));
export const BUCKET = 'mediapack-private';
export const BUCKET_OPTIONS = Object.freeze({ public: false, fileSizeLimit: 52428800,
  allowedMimeTypes: Object.freeze(['video/mp4', 'video/webm', 'image/jpeg', 'application/json']) });
const LOCK = 1297109843;

export class SetupError extends Error {
  constructor(code, message, nextAction) { super(message); this.code = code; this.next_action = nextAction; }
}
function fail(code, message, action) { throw new SetupError(code, message, action); }
export function safeError(error) {
  return error instanceof SetupError ? { error: error.code, hint: error.message, next_action: error.next_action } : {
    error: 'supabase_setup_failed', hint: 'Supabase setup did not complete; provider payloads and credentials were withheld.',
    next_action: 'Check private settings and project status, then run --plan before retrying --apply.',
  };
}

// Keep statement boundaries, but erase comments and quoted bodies before checking transaction control.
function sqlShape(text) {
  let output = '', i = 0;
  while (i < text.length) {
    if (text.startsWith('--', i)) { const end = text.indexOf('\n', i); i = end < 0 ? text.length : end; output += ' '; }
    else if (text.startsWith('/*', i)) {
      let depth = 1; i += 2;
      while (i < text.length && depth) {
        if (text.startsWith('/*', i)) { depth++; i += 2; }
        else if (text.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) fail('invalid_migration', 'A migration contains an unterminated comment.', 'Fix the local migration before setup.');
      output += ' ';
    } else if (text[i] === "'" || text[i] === '"') {
      const quote = text[i++]; let ended = false;
      while (i < text.length) {
        if (text[i++] === quote) {
          if (text[i] === quote) i++;
          else { ended = true; break; }
        }
      }
      if (!ended) fail('invalid_migration', 'A migration contains an unterminated quote.', 'Fix the local migration before setup.');
      output += ' ';
    } else if (text[i] === '$' && /^(?:\$\$|\$[a-z_][a-z0-9_]*\$)/i.test(text.slice(i))) {
      const tag = /^(?:\$\$|\$[a-z_][a-z0-9_]*\$)/i.exec(text.slice(i))[0];
      const end = text.indexOf(tag, i + tag.length);
      if (end < 0) fail('invalid_migration', 'A migration contains an unterminated function body.', 'Fix the local migration before setup.');
      i = end + tag.length; output += ' ';
    } else output += text[i++];
  }
  return output;
}

async function migrationsAt(rootDir) {
  let names;
  try { names = (await readdir(resolve(rootDir, 'supabase/migrations'))).filter(name => name.endsWith('.sql')).sort(); }
  catch { fail('migrations_unavailable', 'Local database migrations could not be read.', 'Run from a complete MediaPack checkout with supabase/migrations available.'); }
  if (!names.length) fail('migrations_unavailable', 'No database migrations were found.', 'Restore the migration files before setup.');
  const migrations = [];
  for (const filename of names) {
    if (!/^[a-z0-9_.-]+\.sql$/i.test(filename)) fail('invalid_migration', 'A migration filename is unsupported.', 'Use simple ordered SQL filenames.');
    const text = await readFile(resolve(rootDir, 'supabase/migrations', filename), 'utf8');
    const shape = sqlShape(text);
    if (shape.split(';').some(statement => /^\s*(?:begin\b|commit\b|end\b|rollback\b|abort\b|start\s+transaction\b|savepoint\b|release\b|prepare\s+transaction\b|set\s+transaction\b)/i.test(statement))) {
      fail('migration_transaction_control', 'A migration manages its own transaction.', 'Remove top-level transaction control; setup wraps each migration and checksum atomically.');
    }
    const objects = [...shape.matchAll(/\bcreate\s+(?:or\s+replace\s+)?(table|function)\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/gi)]
      .map(([, kind, name]) => ({ kind: kind.toLowerCase(), name: name.toLowerCase() }));
    migrations.push({ filename, text, sha256: createHash('sha256').update(text).digest('hex'), objects });
  }
  return migrations;
}

async function dbTransaction(sql, readOnly, run) {
  return sql.begin(readOnly ? 'read only' : '', async tx => {
    await tx.unsafe("set local search_path = public, pg_catalog; set local statement_timeout = '30s'; set local lock_timeout = '5s'; set local idle_in_transaction_session_timeout = '15s'");
    await tx.unsafe('select pg_catalog.pg_advisory_xact_lock($1)', [LOCK]);
    return run(tx);
  });
}

async function inspectMigrations(tx, migrations) {
  const [{ ledger }] = await tx.unsafe("select pg_catalog.to_regclass('mediapack_setup.migrations') as ledger");
  const applied = ledger ? await tx.unsafe('select filename, sha256 from mediapack_setup.migrations order by filename') : [];
  if (applied.length > migrations.length || applied.some((row, index) => row.filename !== migrations[index]?.filename || row.sha256 !== migrations[index]?.sha256)) {
    fail('migration_drift', 'Recorded database migrations differ from this checkout.', 'Restore the exact previously applied migration files. Add a new migration for changes; do not rewrite migration history.');
  }
  const names = [...new Set(migrations.flatMap(m => m.objects.map(o => o.name)))];
  const existing = await tx.unsafe(`select c.relname as name, 'table' as kind from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = any($1::text[])
    union select p.proname as name, 'function' as kind from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any($1::text[])`, [names]);
  if (!applied.length && existing.length) {
    fail('untracked_app_schema', 'Application objects already exist without a migration history.', 'Use a fresh project or have the existing schema audited and explicitly baselined. Setup will not guess or overwrite it.');
  }
  const actual = new Set(existing.map(row => `${row.kind}:${row.name}`));
  const expected = new Set(migrations.slice(0, applied.length).flatMap(m => m.objects.map(o => `${o.kind}:${o.name}`)));
  if ([...expected].some(key => !actual.has(key)) || [...actual].some(key => !expected.has(key))) {
    fail('schema_drift', 'Application objects do not match the recorded migration boundary.', 'Audit the database schema and restore missing objects or remove an incomplete manual migration before retrying.');
  }
  return applied.length;
}

function bucketMatches(data) {
  return data?.id === BUCKET && data.public === false && Number(data.file_size_limit) === BUCKET_OPTIONS.fileSizeLimit &&
    Array.isArray(data.allowed_mime_types) && data.allowed_mime_types.length === BUCKET_OPTIONS.allowedMimeTypes.length &&
    BUCKET_OPTIONS.allowedMimeTypes.every(type => data.allowed_mime_types.includes(type));
}
function storageFailure() {
  fail('storage_configuration_failed', 'The required private 50 MiB bucket could not be configured or verified.',
    'Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Ensure the project global upload limit permits 52428800 bytes (50 MiB). No smaller limit is substituted.');
}
async function inspectBucket(storage) {
  const { data, error } = await storage.getBucket(BUCKET);
  if (error) {
    if (String(error.statusCode ?? error.status) === '404') return null;
    storageFailure();
  }
  if (!data || data.id !== BUCKET) storageFailure();
  return data;
}

export async function setupSupabase({ rootDir = ROOT, envFile = 'apps/web/.env.blaxel', apply = false,
  postgresFactory, createClient, fetchImpl = fetch, timeoutMs = 120_000 } = {}) {
  let env;
  try { env = parseEnv(await readFile(resolve(rootDir, envFile), 'utf8')); }
  catch { fail('env_unavailable', 'The private Supabase settings file could not be read.', 'Save DATABASE_URL, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the --env-file path.'); }
  for (const key of ['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
    if (!env[key]?.trim()) fail('missing_configuration', `Required setting ${key} is missing.`, 'Save the provisioned project settings privately, then rerun --plan.');
  }
  try {
    const db = new URL(env.DATABASE_URL), sb = new URL(env.SUPABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(db.protocol) || !db.hostname || !db.pathname ||
        sb.protocol !== 'https:' || !sb.hostname || sb.username || sb.password || sb.search || sb.hash || sb.pathname !== '/') throw new Error();
  } catch { fail('invalid_configuration', 'DATABASE_URL or SUPABASE_URL has an invalid format.', 'Use the provisioned Postgres connection string and HTTPS project origin without printing either credential.'); }
  const migrations = await migrationsAt(rootDir);
  const postgres = postgresFactory ?? require('postgres');
  createClient ??= require('@supabase/supabase-js').createClient;
  const sql = postgres(env.DATABASE_URL, { max: 1, prepare: false, ssl: true, connect_timeout: 10,
    idle_timeout: 5, onnotice: () => {},
    connection: { application_name: 'mediapack-supabase-setup', statement_timeout: 30000, lock_timeout: 5000 } });
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); void sql.end({ timeout: 0 }).catch(() => {}); }, timeoutMs);
  const boundedFetch = (input, init = {}) => fetchImpl(input, { ...init, redirect: 'error',
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000), ...(init.signal ? [init.signal] : [])]) });
  try {
    const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: boundedFetch },
    });
    const storage = client.storage;
    const initial = await dbTransaction(sql, true, tx => inspectMigrations(tx, migrations));
    const bucket = await inspectBucket(storage);
    const action = bucket ? bucketMatches(bucket) ? 'reuse' : 'update' : 'create';
    let applied = 0;
    if (apply) {
      // Recheck under the same advisory lock before each atomic SQL + checksum commit.
      for (let index = initial; index < migrations.length; index++) {
        await dbTransaction(sql, false, async tx => {
          const current = await inspectMigrations(tx, migrations);
          if (current > index) return; // Another initializer committed while this one waited.
          if (current !== index) fail('migration_order_changed', 'The migration boundary changed during setup.', 'Rerun --plan before applying again.');
          if (!index) await tx.unsafe(`create schema if not exists mediapack_setup;
            revoke all on schema mediapack_setup from public;
            create table if not exists mediapack_setup.migrations (
              filename text primary key, sha256 text not null check (length(sha256) = 64),
              applied_at timestamptz not null default now());
            revoke all on table mediapack_setup.migrations from public;
            alter table mediapack_setup.migrations enable row level security`);
          await tx.unsafe(migrations[index].text);
          await tx.unsafe('insert into mediapack_setup.migrations (filename, sha256) values ($1, $2)',
            [migrations[index].filename, migrations[index].sha256]);
          applied++;
        });
      }
      await dbTransaction(sql, true, tx => inspectMigrations(tx, migrations));
      if (action !== 'reuse') {
        const options = { ...BUCKET_OPTIONS, allowedMimeTypes: [...BUCKET_OPTIONS.allowedMimeTypes] };
        const result = action === 'create' ? await storage.createBucket(BUCKET, options) : await storage.updateBucket(BUCKET, options);
        if (result.error) storageFailure();
      }
      if (!bucketMatches(await inspectBucket(storage))) storageFailure();
    }
    return { mode: apply ? 'apply' : 'plan', required_settings_present: true,
      migrations_found: migrations.length, migrations_previously_applied: initial,
      migrations_pending: apply ? 0 : migrations.length - initial, migrations_applied: applied,
      bucket_action: action, bucket_private: apply || bucket?.public === false,
      bucket_file_size_limit_bytes: apply ? BUCKET_OPTIONS.fileSizeLimit : bucket?.file_size_limit ?? null,
      bucket_allowed_mime_types: apply ? [...BUCKET_OPTIONS.allowedMimeTypes] : bucket?.allowed_mime_types ?? null,
      required_bucket_file_size_limit_bytes: BUCKET_OPTIONS.fileSizeLimit,
      required_bucket_allowed_mime_types: [...BUCKET_OPTIONS.allowedMimeTypes], bucket_configuration_verified: apply || bucketMatches(bucket),
      global_upload_limit_verified: false,
      next_action: apply ? 'Verify the project global upload limit is at least 52428800 bytes, restart the hosted app with these private settings, and exercise session creation and upload.'
        : 'Review the pending migration and bucket settings, then run --apply. The project global upload limit must permit 52428800 bytes.' };
  } catch (error) {
    if (error instanceof SetupError) throw error;
    fail(controller.signal.aborted ? 'setup_timeout' : 'supabase_setup_failed',
      controller.signal.aborted ? 'Supabase setup exceeded its deadline.' : 'Supabase setup could not complete; provider payloads were withheld.',
      'Check project connectivity, database SSL and role permissions, and service-role storage permissions. Rerun --plan; committed migrations are tracked and failed migrations roll back.');
  } finally {
    clearTimeout(timer);
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

async function main() {
  let values;
  try { ({ values } = parseArgs({ options: { plan: { type: 'boolean' }, apply: { type: 'boolean' },
    'env-file': { type: 'string', default: 'apps/web/.env.blaxel' }, help: { type: 'boolean', short: 'h' } } })); }
  catch { fail('invalid_options', 'Unsupported or incomplete setup options.', 'Run node scripts/setup-supabase.mjs --help.'); }
  if (values.help) {
    console.log('Usage: node scripts/setup-supabase.mjs [--plan | --apply] [--env-file PATH]\nDefault --plan is read-only. --apply initializes the existing database using atomic checksummed migrations, then configures the private 50 MiB mediapack-private bucket for Supabase Free. Requires DATABASE_URL, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the private env file. Never creates an account, changes a billing plan, or substitutes a smaller upload limit.');
    return;
  }
  if (values.plan && values.apply) fail('invalid_options', 'Choose either --plan or --apply.', 'Use --plan to inspect or --apply to initialize the provisioned backend.');
  console.log(JSON.stringify(await setupSupabase({ apply: values.apply, envFile: values['env-file'] }), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(JSON.stringify(safeError(error))); process.exitCode = 1; });
}
