#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP = `MediaPack end-to-end caller (Stripe sandbox only)

Usage: node scripts/e2e.mjs --video FILE --query QUESTION [options]
       node scripts/e2e.mjs --job UUID --query QUESTION [options]

  --url ORIGIN     Next.js API origin (or MEDIAPACK_URL)
  --config FILE    CLI private owner state (or MEDIAPACK_CONFIG)
  --video FILE     New local MP4/WebM (or MEDIAPACK_E2E_VIDEO)
  --query TEXT     Arbitrary question (or MEDIAPACK_E2E_QUERY); no timestamps required
  --job UUID       Resume an existing owned job instead of uploading
  --run-dir DIR    Private run artifacts/state (default /tmp/mediapack-e2e-<UUID>)
  --buy            Explicitly authorize the CLI's USD 0.50 sandbox purchase
  --via METHOD     mppx (default) or installed/authenticated link-cli
  --timeout SEC    Per-operation polling deadline (default 900)
  --help, -h       Print help

Without --buy, an unpaid job stops at the quote and prints purchase_required.
Rerun with the printed --run-dir and --buy to continue the same source/job.
Paid jobs need no --buy. No match is a successful evidence outcome. Exhausted
allowance is reported without buying a replacement pack. Capabilities/SPTs and
signed URLs are excluded from run-manifest.json.
`;

const cli = fileURLToPath(new URL('./mediapack.mjs', import.meta.url));
let state;
let runDir;
let statePath;
let manifestPath;
let flags;

async function persist() {
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  const { request_ids, ...manifest } = state;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}
async function call(args, { allowFailure = false } = {}) {
  const globals = ['--timeout', flags.timeout ?? '900'];
  if (flags.url) globals.push('--url', flags.url);
  if (flags.config) globals.push('--config', flags.config);
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [cli, ...globals, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`CLI step timed out: ${args[0]}. Resume this run directory; inspect payment state before any purchase.`)); }, (Number(flags.timeout ?? 900) + 220) * 1000);
    child.stdout.on('data', (b) => { stdout += b; });
    child.stderr.on('data', (b) => { stderr += b; process.stderr.write(b); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let body;
      try { body = stdout.trim() ? JSON.parse(stdout) : null; } catch { return reject(new Error(`CLI ${args[0]} returned non-JSON output.`)); }
      if (code !== 0 && !allowFailure) return reject(new Error(`CLI ${args[0]} failed (exit ${code}). ${body?.reject?.message ?? body?.error?.message ?? body?.detail ?? ''} ${stderr.trim()}`));
      done({ code, body, stderr });
    });
  });
}
const value = async (args) => (await call(args)).body;
function rid(kind) {
  state.request_ids ??= {};
  return state.request_ids[kind] ??= randomUUID();
}
async function finish(outcome, detail) {
  state.outcome = outcome;
  state.detail = detail;
  state.updated_at = new Date().toISOString();
  await persist();
  console.log(JSON.stringify({ outcome, job_id: state.job_id ?? null, video_id: state.video_id ?? null, run_dir: runDir, manifest: manifestPath, detail }, null, 2));
}
async function op(kind, args) {
  const request = rid(kind);
  await persist();
  const result = await call([...args, '--request-id', request, '--wait'], { allowFailure: true });
  if (result.code && /ALLOWANCE_EXCEEDED/.test(result.stderr)) {
    await finish('allowance_exhausted', `The ${kind} allowance is unavailable; inspect the existing pack and remaining usage. No new purchase was attempted.`);
    return null;
  }
  if (result.code || result.body?.state !== 'succeeded') throw new Error(`${kind} did not succeed. Resume this run directory after resolving the persisted operation: ${result.stderr.trim()}`);
  state.operations ??= {};
  state.operations[kind] = { operation_id: result.body.operation_id, request_id: request, state: result.body.state };
  await persist();
  return result.body;
}
async function download(ref) {
  if (!/^[0-9a-f-]{36}$/i.test(ref.artifact_id ?? '') || !/^[a-f0-9]{64}$/.test(ref.sha256 ?? '')) throw new Error('Delivered artifact has no valid ID/SHA-256.');
  const ext = ref.kind === 'clip' ? 'mp4' : ref.content_type === 'image/png' ? 'png' : 'jpg';
  const path = join(runDir, `${ref.artifact_id}.${ext}`);
  const exists = await stat(path).catch((e) => { if (e.code !== 'ENOENT') throw e; return null; });
  if (!exists) await value(['artifact', ref.artifact_id, '--out', path]);
  const bytes = await readFile(path);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (!bytes.length || digest !== ref.sha256) throw new Error(`Artifact ${ref.artifact_id} failed its SHA-256 check; inspect ${path} before rerunning.`);
  return { artifact_id: ref.artifact_id, kind: ref.kind, sha256: digest, bytes: bytes.length, file: path, requested_ms: ref.requested_ms, actual_ms: ref.actual_ms, content_type: ref.content_type };
}

async function main() {
  flags = parseArgs({ options: {
    video: { type: 'string' }, query: { type: 'string' }, job: { type: 'string' }, url: { type: 'string' }, config: { type: 'string' },
    'run-dir': { type: 'string' }, buy: { type: 'boolean' }, via: { type: 'string' }, timeout: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } }).values;
  if (flags.help) { console.log(HELP); return; }
  const seconds = Number(flags.timeout ?? 900);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) throw new Error('--timeout must be 1–3600 seconds.');
  runDir = resolve(flags['run-dir'] ?? join('/tmp', `mediapack-e2e-${randomUUID()}`));
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  const mode = (await stat(runDir)).mode;
  if (mode & 0o077) throw new Error('Run directory must be private (chmod 700).');
  statePath = join(runDir, 'state.json');
  manifestPath = join(runDir, 'run-manifest.json');
  try { state = JSON.parse(await readFile(statePath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; state = { schema_version: 'mediapack.e2e.v1', request_ids: {}, started_at: new Date().toISOString() }; }
  const query = flags.query ?? process.env.MEDIAPACK_E2E_QUERY ?? state.query;
  const video = flags.video ?? process.env.MEDIAPACK_E2E_VIDEO;
  if (typeof query !== 'string' || query.trim().length < 3 || query.length > 500) throw new Error('Supply an arbitrary 3–500 character --query (or MEDIAPACK_E2E_QUERY).');
  if (state.query && state.query !== query) throw new Error('This run directory already belongs to a different query; choose a new --run-dir.');
  if (flags.job && state.job_id && flags.job !== state.job_id) throw new Error('This run directory belongs to a different job.');
  state.query = query;
  const origin = flags.url ?? process.env.MEDIAPACK_URL ?? 'http://localhost:3000';
  if (state.service_origin && state.service_origin !== origin) throw new Error('This run directory belongs to another service origin.');
  state.service_origin = origin;
  state.mode = 'test';
  if (!flags.job && !state.job_id && !state.video_id && !video) throw new Error('Supply --video FILE for a new run, or --job UUID to inspect an existing owned job.');
  console.error(`Run directory: ${runDir}`);
  const owned = await call(['videos'], { allowFailure: true });
  if (owned.code) {
    if (!/No owner capability/.test(owned.stderr)) throw new Error('Owner discovery failed; fix the CLI configuration rather than creating another client.');
    await value(['bootstrap', '--name', 'mediapack-e2e']);
  }
  if (flags.job) state.job_id = flags.job;
  if (!state.job_id) {
    if (!state.video_id) {
      const request = rid('upload');
      await persist();
      // Persist video identity before waiting, so preflight failures can be resumed.
      const uploaded = await value(['upload', resolve(video), '--request-id', request]);
      state.video_id = uploaded.video_id ?? uploaded.video?.video_id;
      if (!state.video_id) throw new Error('Upload returned no video ID.');
      await persist();
    }
    const verified = await value(['video', state.video_id, '--wait']);
    if (verified.state !== 'ready' || !verified.sha256) throw new Error(`Preflight did not validate the source (state=${verified.state}).`);
    state.source = { video_id: verified.video_id, sha256: verified.sha256, duration_ms: verified.duration_ms };
    const quote = await value(['quote', state.video_id]);
    state.quote = { quote_id: quote.quote_id, amount_minor: quote.amount_minor, currency: quote.currency, payment_mode: quote.payment_mode, terms_hash: quote.terms_hash };
    state.job_id = quote.job_id;
    await persist();
  }
  let job = await value(['status', state.job_id]);
  if (job.quote?.payment_mode !== 'test') throw new Error('The end-to-end runner accepts only Stripe sandbox jobs.');
  state.video_id = job.video.video_id;
  state.source = { video_id: job.video.video_id, sha256: job.video.sha256, duration_ms: job.video.duration_ms };
  if (job.payment_state === 'unpaid') {
    if (!flags.buy) return finish('purchase_required', `Review job ${state.job_id} and its USD 0.50 sandbox quote. To authorize the purchase, rerun: node scripts/e2e.mjs --run-dir ${JSON.stringify(runDir)} --buy (preserve MEDIAPACK_URL/config).`);
    await value(['buy', state.job_id, '--via', flags.via ?? 'mppx']);
  }
  job = await value(['status', state.job_id, '--wait']);
  if (job.payment_state !== 'paid' || job.state !== 'ready') throw new Error(`Job is not ready: payment=${job.payment_state}, state=${job.state}. Do not buy another pack.`);
  state.payment_intent_id = job.payment_intent_id;
  state.remaining = job.remaining;
  const searched = await op('search', ['search', state.job_id, query]);
  if (!searched) return;
  const search = searched.result;
  if (!Array.isArray(search?.matches)) throw new Error('Search completed without a valid matches array.');
  state.search = { answer: search.answer, matches: search.matches, coverage: search.coverage };
  if (search.matches.length === 0) return finish('no_match', 'No match was established from the indexed evidence; no frames or clip were requested.');
  const duration = job.video.duration_ms;
  const match = search.matches.find((m) => Number.isInteger(m.start_ms) && Number.isInteger(m.end_ms) && m.start_ms >= 0 && m.end_ms > m.start_ms && m.end_ms <= duration);
  if (!match) throw new Error('Search supplied matches but no interval valid for this source.');
  state.selected_match = match;
  job = await value(['status', state.job_id]);
  const available = job.remaining;
  state.downloads ??= [];
  if (available.frames > 0 || state.frame_timestamps) {
    const timestamps = state.frame_timestamps ?? [...new Set([match.start_ms, Math.min(duration - 1, Math.floor((match.start_ms + match.end_ms) / 2))])].slice(0, Math.min(2, available.frames));
    state.frame_timestamps = timestamps;
    const frames = await op('frames', ['frames', state.job_id, timestamps.join(',')]);
    if (!frames) return;
    if (!Array.isArray(frames.result?.artifacts) || !frames.result.artifacts.length || frames.result.artifacts.some((a) => a.kind !== 'frame')) throw new Error('Frame operation succeeded without source frame artifacts.');
    for (const artifact of frames.result.artifacts) {
      const downloaded = await download(artifact);
      state.downloads = [...state.downloads.filter((a) => a.artifact_id !== artifact.artifact_id), downloaded];
    }
    await persist();
  } else state.frame_limit = 'No frame allowance remains; existing pack retained.';
  const end = state.clip_range?.end_ms ?? Math.min(match.end_ms, match.start_ms + Math.min(6000, available.clip_ms));
  if (end > match.start_ms) {
    state.clip_range = { start_ms: match.start_ms, end_ms: end };
    const clip = await op('clip', ['clip', state.job_id, String(match.start_ms), String(end)]);
    if (!clip) return;
    if (!Array.isArray(clip.result?.artifacts) || clip.result.artifacts.length !== 1 || clip.result.artifacts[0].kind !== 'clip' || clip.result.artifacts[0].content_type !== 'video/mp4') throw new Error('Clip operation succeeded without a source MP4 artifact.');
    for (const artifact of clip.result.artifacts) {
      const downloaded = await download(artifact);
      state.downloads = [...state.downloads.filter((a) => a.artifact_id !== artifact.artifact_id), downloaded];
    }
    await persist();
  } else state.clip_limit = 'No clip allowance remains; existing pack retained.';
  const pack = await value(['pack', state.job_id]);
  state.receipt = pack.receipt;
  state.usage = pack.usage;
  state.artifacts = (pack.artifacts ?? []).map(({ url, url_expires_at, ...ref }) => ref);
  state.events = (await value(['events', state.job_id])).map((event) => ({ id: event.id, kind: event.kind, operation_id: event.operation_id, created_at: event.created_at,
    references: Object.fromEntries(['message_id', 'request_message_id', 'result_message_id', 'sandbox_id'].filter((key) => typeof event.details?.[key] === 'string').map((key) => [key, event.details[key]])),
  }));
  const exhausted = !!state.frame_limit || !!state.clip_limit;
  await finish(exhausted ? 'partial_allowance_exhausted' : 'evidence_verified', exhausted ? 'Search and available evidence completed; one media allowance was exhausted. No replacement purchase attempted.' : 'Search-derived source interval retrieved; every downloaded artifact passed its SHA-256 check. Inspect the clip in a video player to verify playback.');
}

try { await main(); }
catch (error) {
  const message = String(error.message ?? error).replace(/(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+|spt_[A-Za-z0-9_]+|mp_[A-Za-z0-9_-]{20,}/g, '[redacted]');
  console.error(`mediapack e2e: ${message}`);
  if (state && statePath) await finish('failed', message).catch(() => {});
  process.exitCode = 1;
}
