#!/usr/bin/env node
import { createReadStream, constants } from 'node:fs';
import { chmod, mkdir, open, rename, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { createSandboxTokenIssuer } from './stripe-buyer.mjs';

const HELP = `MediaPack 1.0.0 — upload, purchase a sandbox pack, retrieve source evidence

Usage: node scripts/mediapack.mjs <command> [arguments] [options]

  bootstrap [--name NAME]                 Create and privately save an owner capability
  upload FILE [--request-id UUID]         Stream MP4/WebM, complete upload, start preflight
  complete VIDEO                         Retry upload completion
  videos                                 List owned videos
  video VIDEO [--wait]                    Inspect preflight state
  quote VIDEO                            Freeze a validated video's quote
  buy JOB [--via mppx|link]               Purchase in Stripe sandbox only
  status JOB [--wait]                     Inspect payment, indexing and allowance
  search JOB QUESTION [--wait]            Search the index (question '-' reads stdin)
  frames JOB MS,MS [--wait]               Retrieve source frames at millisecond offsets
  clip JOB START_MS END_MS [--wait]       Extract up to 15 seconds of source video
  operation JOB OPERATION [--wait]        Inspect an asynchronous operation
  events JOB [--after ID]                 Read persisted activity
  pack JOB [--out FILE]                   Retrieve the evidence manifest
  artifact ARTIFACT [--out FILE]          Mint access or download with SHA-256 verification
  pair                                   Issue a one-time browser pairing code
  health                                 Inspect configuration gates (no secrets)

Options:
  --url ORIGIN        Service origin (MEDIAPACK_URL, default http://localhost:3000)
  --config FILE       Private state file (MEDIAPACK_CONFIG or ~/.config/mediapack/client.json)
  --request-id UUID   Stable idempotency key; repeat with the identical input to retry
  --wait              Poll video/job/operation until terminal, bounded by --timeout
  --timeout SECONDS   Overall polling deadline (default 300); HTTP requests have timeouts
  --out FILE          Save JSON or artifact without overwriting an existing file
  --via METHOD        mppx (default) or installed link-cli
  --spend-request-id ID  Reuse and save an approved Link sandbox spend request
  --context TEXT      Link approval explanation (at least 100 characters)
  --max-results N     Search results (1–3, default 3)
  --help, -h          Show help
  --version          Show version

JSON goes to stdout; progress and retry identifiers go to stderr. The bootstrap
response omits the capability. Signed artifact URLs and pairing codes are sensitive.
Buyer env: MPPX_STRIPE_SECRET_KEY=sk_test_... (mppx); Link requires its own login.
Explicit internal sandbox network: MPPX_STRIPE_TEST_NETWORK_ID=internal (mppx only).
No automatic purchase retries. An uncertain outcome must be inspected with status.
`;

const { values: flags, positionals } = parseArgs({ allowPositionals: true, options: {
  help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' }, url: { type: 'string' }, config: { type: 'string' },
  name: { type: 'string' }, 'request-id': { type: 'string' }, wait: { type: 'boolean' }, timeout: { type: 'string' },
  out: { type: 'string' }, via: { type: 'string' }, 'spend-request-id': { type: 'string' }, context: { type: 'string' },
  'max-results': { type: 'string' }, after: { type: 'string' },
} });
const [command, ...args] = positionals;
const configPath = resolve(flags.config ?? process.env.MEDIAPACK_CONFIG ?? join(homedir(), '.config/mediapack/client.json'));
const timeout = Number(flags.timeout ?? 300) * 1000;
const rootRequire = createRequire(new URL('../apps/mediapack/package.json', import.meta.url));
let state = { version: 1, servers: {} };
let origin;
let account;

function fail(message) { throw new Error(message); }
function uint(value, name) {
  if (!/^\d+$/.test(value ?? '') || !Number.isSafeInteger(Number(value))) fail(`${name} must be a nonnegative integer in milliseconds.`);
  return Number(value);
}
function uuid(value, name) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value ?? '')) fail(`${name} must be a UUID.`);
  return value;
}
function id(index = 0) { return encodeURIComponent(uuid(args[index], 'ID')); }
function requestId() {
  const value = flags['request-id'] ? uuid(flags['request-id'], 'request-id') : randomUUID();
  console.error(`request_id=${value} (reuse with identical input for a safe retry)`);
  return value;
}
function safeUrl(raw, base = origin) {
  const url = new URL(raw, base);
  if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) fail('URLs must use HTTP(S) without embedded credentials.');
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) fail('Remote services and storage must use HTTPS.');
  return url;
}
async function privateWrite(file, data) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(tmp, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`); } finally { await handle.close(); }
  await rename(tmp, file);
  await chmod(file, 0o600);
}
async function save() { state.servers[origin] = account; await privateWrite(configPath, state); }
async function load() {
  try {
    const handle = await open(configPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.mode & 0o077 || (process.getuid && info.uid !== process.getuid())) fail(`State must be an owned private file: chmod 600 ${configPath}`);
      state = JSON.parse(await handle.readFile('utf8'));
      if (state.version !== 1 || !state.servers) fail('Unsupported state file; choose a new --config path.');
    } finally { await handle.close(); }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const supplied = safeUrl(flags.url ?? process.env.MEDIAPACK_URL ?? 'http://localhost:3000');
  if (supplied.pathname !== '/' || supplied.search || supplied.hash) fail('--url must be a service origin without a path, query or fragment.');
  origin = supplied.origin;
  account = state.servers[origin] ?? { quotes: {}, purchases: {} };
}
function capability() {
  const value = process.env.MEDIAPACK_TOKEN ?? account.capability;
  if (!value) fail('No owner capability. Run bootstrap with the same --url and --config.');
  return value;
}
async function http(path, { method = 'GET', body, auth = true, headers = {}, timeoutMs = 30_000 } = {}) {
  const url = safeUrl(path);
  if (url.origin !== origin) fail('Refusing to send owner credentials to a different origin.');
  return fetch(url, { method, redirect: 'error', headers: {
    accept: 'application/json', ...(auth ? { 'X-MediaPack-Token': capability() } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers,
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs) });
}
async function decoded(response) {
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { fail(`Service returned non-JSON (HTTP ${response.status}); check --url and server logs.`); }
  if (!response.ok) {
    const error = body.error;
    fail(`HTTP ${response.status}: ${error?.code ?? ''} ${error?.message ?? (typeof error === 'string' ? error : 'request failed')}${body.hint ? `; ${body.hint}` : ''}${error?.next_action ?? body.next_action ? `; ${error?.next_action ?? body.next_action}` : ''}`);
  }
  return body;
}
async function api(path, options) { return decoded(await http(path, options)); }
async function emit(body) {
  const json = `${JSON.stringify(body, null, 2)}\n`;
  if (flags.out) {
    await writeNew(flags.out, json);
    console.error(`Saved ${resolve(flags.out)}`);
  } else process.stdout.write(json);
}
async function writeNew(file, data) {
  const handle = await open(resolve(file), 'wx', 0o600);
  try { await handle.writeFile(data); } finally { await handle.close(); }
}
async function wait(path, initial, terminal) {
  if (!flags.wait) return initial;
  const deadline = Date.now() + timeout;
  let value = initial;
  while (!terminal(value)) {
    if (Date.now() >= deadline) fail('Polling deadline reached; inspect the same ID with status, video or operation.');
    console.error(`state=${value.state ?? value.payment_state ?? 'pending'}`);
    await new Promise((r) => setTimeout(r, Math.min(2000, deadline - Date.now())));
    value = await api(path, { timeoutMs: Math.min(30_000, Math.max(1, deadline - Date.now())) });
  }
  if (['failed', 'rejected', 'expired'].includes(value.state)) process.exitCode = 3;
  return value;
}
async function operation(kind, body) {
  const job = id();
  const result = await api(`/v1/jobs/${job}/${kind}`, { method: 'POST', body: { request_id: requestId(), ...body } });
  return wait(`/v1/jobs/${job}/operations/${result.operation_id}`, result, (v) => ['succeeded', 'failed'].includes(v.state));
}
async function buy() {
  const jobId = id();
  const job = await api(`/v1/jobs/${jobId}`);
  if (job.payment_state === 'paid' || job.payment_state === 'reconciling') return emit(job);
  const q = job.quote;
  if (!q || q.job_id !== args[0] || q.payment_mode !== 'test' || q.currency.toLowerCase() !== 'usd' || q.amount_minor !== 50) fail('Buyer only authorizes the USD 0.50 Stripe sandbox pack. Inspect quote.');
  if (Date.parse(q.expires_at) <= Date.now()) fail('Quote expired. Request a fresh quote for this video.');
  const purchaseUrl = safeUrl(q.purchase_url);
  if (purchaseUrl.origin !== origin || purchaseUrl.pathname !== `/v1/jobs/${jobId}/purchase`) fail('Quote purchase URL does not match this job and origin.');
  const body = { quote_id: q.quote_id };
  const via = flags.via ?? 'mppx';
  if (!['mppx', 'link'].includes(via)) fail('--via must be mppx or link.');
  account.purchases ??= {};
  const previous = account.purchases[jobId];
  if (previous && previous.quote_id === q.quote_id && previous.state === 'started') fail('A prior buyer attempt has an uncertain outcome. Inspect status and wait for reconciliation; do not mint a second payment token.');
  console.error(`Sandbox purchase: USD 0.50, job=${jobId}, quote=${q.quote_id}, via=${via}`);
  // Validate credentials/tool availability before marking an attempt as started.
  let client;
  if (via === 'mppx') client = await stripeBuyer(q);
  else await linkHelp();
  account.purchases[jobId] = { quote_id: q.quote_id, via, state: 'started', started_at: new Date().toISOString(),
    ...(flags['spend-request-id'] ? { spend_request_id: flags['spend-request-id'] } : {}) };
  await save();
  try {
    if (via === 'mppx') {
      const response = await client.fetch(purchaseUrl, { method: 'POST', headers: { 'X-MediaPack-Token': capability(), 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(90_000) });
      await decoded(response);
    } else await linkBuy(purchaseUrl, body, jobId);
    const fresh = await api(`/v1/jobs/${jobId}`);
    account.purchases[jobId].state = fresh.payment_state;
    await save();
    if (!['paid', 'reconciling'].includes(fresh.payment_state)) process.exitCode = 3;
    return emit(fresh);
  } catch (error) {
    // Preserve the started marker even if a transport fails after the merchant charged.
    console.error('Purchase outcome may be uncertain. Inspect status for this job before any further payment.');
    throw error;
  }
}
async function stripeBuyer(q) {
  const createToken = createSandboxTokenIssuer({ quote: q, key: process.env.MPPX_STRIPE_SECRET_KEY,
    testNetworkId: process.env.MPPX_STRIPE_TEST_NETWORK_ID });
  const { Mppx, stripe } = await import(pathToFileURL(rootRequire.resolve('mppx/client')));
  return Mppx.create({ polyfill: false, maxPaymentRetries: 1, methods: [stripe.charge({ paymentMethod: 'pm_card_visa', createToken })] });
}
async function linkHelp() {
  const result = await subprocess('link-cli', ['mpp', 'pay', '--help'], 15_000);
  for (const flag of ['--test', '--method', '--data', '--header', '--spend-request-id', '--context']) {
    if (!result.includes(flag)) fail(`Installed link-cli mpp pay lacks ${flag}; review the installed CLI before purchasing.`);
  }
}
async function subprocess(bin, argv, deadline, onChunk) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${bin} timed out; inspect job status before retrying a purchase.`)); }, deadline);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => {
      const text = data.toString();
      output = (output + text).slice(-256_000);
      onChunk?.(text);
    });
    child.on('error', () => { clearTimeout(timer); reject(new Error(`${bin} is unavailable; install and authenticate it in your terminal.`)); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(`${bin} exited ${code}; inspect status before retrying.`)); });
  });
}
async function linkBuy(url, body, jobId) {
  const nonce = randomUUID();
  // Link receives a local opaque URL, never the reusable owner capability in process arguments.
  const proxy = createServer(async (req, res) => {
    try {
      if (req.url !== `/${nonce}` || req.method !== 'POST') { res.writeHead(404).end(); return; }
      let size = 0;
      const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 1024) fail('Link request too large.'); chunks.push(chunk); }
      if (Buffer.concat(chunks).toString() !== JSON.stringify(body)) fail('Link changed the quote request body.');
      const upstream = await http(url, { method: 'POST', body, headers: req.headers.authorization ? { authorization: req.headers.authorization } : {}, timeoutMs: 90_000 });
      const headers = { 'content-type': 'application/json' };
      for (const key of ['www-authenticate', 'payment-receipt', 'retry-after']) if (upstream.headers.has(key)) headers[key] = upstream.headers.get(key);
      res.writeHead(upstream.status, headers).end(await upstream.text());
    } catch { res.writeHead(502, { 'content-type': 'application/json' }).end('{"error":"buyer proxy failed; inspect job status"}'); }
  });
  await new Promise((r, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', r); });
  try {
    const argv = ['mpp', 'pay', `http://127.0.0.1:${proxy.address().port}/${nonce}`, '--test', '--method', 'POST', '--data', JSON.stringify(body)];
    const spend = flags['spend-request-id'];
    if (spend) argv.push('--spend-request-id', spend);
    else {
      const context = flags.context ?? `Purchase the MediaPack USD 0.50 Stripe sandbox evidence pack for job ${jobId}, limited to the quoted immutable source and purchased allowance. This is a test purchase.`;
      if (context.length < 100) fail('--context must contain at least 100 characters.');
      argv.push('--context', context);
    }
    let found = '';
    const output = await subprocess('link-cli', argv, Math.max(timeout, 90_000), (chunk) => {
      found = (found + chunk).slice(-4000);
      const spendId = found.match(/\blsrq_[A-Za-z0-9_]+\b/)?.[0];
      if (spendId && account.purchases[jobId].spend_request_id !== spendId) {
        account.purchases[jobId].spend_request_id = spendId;
        // Await the final write below; this also starts persistence during approval.
        pendingSave = pendingSave.then(() => save()).catch((error) => { pendingSaveError = error; });
      }
    });
    void output; // Wallet output can contain an SPT. Never echo it.
  } finally {
    await pendingSave;
    proxy.closeAllConnections();
    await new Promise((r) => proxy.close(r));
    if (pendingSaveError) throw pendingSaveError;
  }
}
let pendingSave = Promise.resolve();
let pendingSaveError;

async function main() {
  if (flags.version) { console.log('1.0.0'); return; }
  if (flags.help || !command) { console.log(HELP); return; }
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 3_600_000) fail('--timeout must be 1–3600 seconds.');
  await load();
  switch (command) {
    case 'bootstrap': {
      if (account.capability) fail('This origin already has a saved owner; use it or choose another --config.');
      const result = await api('/v1/clients', { auth: false, method: 'POST', body: { display_name: flags.name ?? 'mediapack-cli' } });
      if (!result.capability || !result.client_id) fail('Bootstrap returned no owner capability.');
      Object.assign(account, { capability: result.capability, client_id: result.client_id, expires_at: result.expires_at });
      await save();
      return emit({ client_id: result.client_id, expires_at: result.expires_at, config: configPath });
    }
    case 'health': return emit(await api('/health', { auth: false }));
    case 'videos': return emit(await api('/v1/videos'));
    case 'upload': {
      if (!args[0]) fail('upload requires a local MP4/WebM path.');
      const file = resolve(args[0]);
      const info = await stat(file);
      const contentType = { '.mp4': 'video/mp4', '.webm': 'video/webm' }[extname(file).toLowerCase()];
      if (!info.isFile() || !contentType || info.size <= 0 || info.size > 50 * 1024 ** 2) fail('Upload requires a nonempty MP4/WebM regular file of at most 50 MiB. Server preflight validates actual media.');
      const result = await api('/v1/videos', { method: 'POST', body: { request_id: requestId(), file_name: basename(file), size_bytes: info.size, content_type: contentType } });
      console.error(`video_id=${result.video_id}`);
      if (result.upload) {
        const response = await fetch(safeUrl(result.upload.url), { method: 'PUT', redirect: 'error', headers: { ...result.upload.headers, 'content-length': String(info.size) }, body: createReadStream(file), duplex: 'half', signal: AbortSignal.timeout(180_000) });
        if (!response.ok) fail(`Storage upload failed (HTTP ${response.status}); retry with the same request-id. Signed URL omitted.`);
      }
      const complete = await api(`/v1/videos/${result.video_id}/complete`, { method: 'POST', body: { request_id: randomUUID() } });
      return emit(await wait(`/v1/videos/${result.video_id}`, complete.video ?? complete, (v) => ['ready', 'rejected', 'expired'].includes(v.state)));
    }
    case 'complete': return emit(await api(`/v1/videos/${id()}/complete`, { method: 'POST', body: { request_id: requestId() } }));
    case 'video': { const path = `/v1/videos/${id()}`; return emit(await wait(path, await api(path), (v) => ['ready', 'rejected', 'expired'].includes(v.state))); }
    case 'quote': {
      const quote = await api(`/v1/videos/${id()}/quotes`, { method: 'POST', body: { request_id: requestId() } });
      account.quotes ??= {}; account.quotes[quote.job_id] = quote; await save(); return emit(quote);
    }
    case 'buy': return buy();
    case 'status': { const path = `/v1/jobs/${id()}`; return emit(await wait(path, await api(path), (v) => ['ready', 'failed', 'expired'].includes(v.state) || v.payment_state === 'unpaid')); }
    case 'search': {
      let query = args.slice(1).join(' ');
      if (query === '-') {
        const chunks = [];
        let size = 0;
        for await (const chunk of process.stdin) { size += chunk.length; if (size > 4000) fail('Question stdin exceeds 4000 bytes.'); chunks.push(chunk); }
        query = Buffer.concat(chunks).toString('utf8').trim();
      }
      const max = Number(flags['max-results'] ?? 3);
      if (query.length < 3 || query.length > 500 || !Number.isInteger(max) || max < 1 || max > 3) fail('Search requires 3–500 characters and --max-results 1–3.');
      return emit(await operation('searches', { query, max_results: max }));
    }
    case 'frames': {
      const timestamps = (args[1] ?? '').split(',').map((v) => uint(v, 'timestamp'));
      if (timestamps.length > 8) fail('At most eight frame timestamps per pack.');
      return emit(await operation('frames', { timestamps_ms: timestamps }));
    }
    case 'clip': {
      const start = uint(args[1], 'start'), end = uint(args[2], 'end');
      if (end <= start || end - start > 15_000) fail('Clip end must follow start by at most 15000 ms.');
      return emit(await operation('clips', { start_ms: start, end_ms: end }));
    }
    case 'operation': { const path = `/v1/jobs/${id()}/operations/${id(1)}`; return emit(await wait(path, await api(path), (v) => ['succeeded', 'failed'].includes(v.state))); }
    case 'events': return emit(await api(`/v1/jobs/${id()}/events?after=${uint(flags.after ?? '0', 'after')}`));
    case 'pack': return emit(await api(`/v1/jobs/${id()}/pack`));
    case 'pair': return emit({ ...await api('/v1/clients/viewer-code', { method: 'POST' }), viewer_url: `${origin}/app/pair`, instruction: 'Open viewer_url and paste the one-time code; do not bootstrap a different browser owner.' });
    case 'artifact': {
      const access = await api(`/v1/artifacts/${id()}/access`);
      if (!flags.out) return emit(access);
      const artifact = access.artifact ?? access;
      const url = access.url ?? artifact.url;
      if (!url) fail('Artifact access returned no signed URL.');
      const response = await fetch(safeUrl(url), { redirect: 'error', signal: AbortSignal.timeout(180_000) });
      if (!response.ok || !response.body) fail(`Artifact download failed (HTTP ${response.status}).`);
      const handle = await open(resolve(flags.out), 'wx', 0o600);
      try {
        const hash = createHash('sha256');
        for await (const chunk of Readable.fromWeb(response.body)) { hash.update(chunk); await handle.write(chunk); }
        const digest = hash.digest('hex');
        if (artifact.sha256 && digest !== artifact.sha256) fail('Downloaded artifact hash mismatch; discard the output file.');
        console.log(JSON.stringify({ path: resolve(flags.out), sha256: digest }));
      } finally { await handle.close(); }
      return;
    }
    default: fail(`Unknown command: ${command}. Run --help.`);
  }
}

try { await main(); } catch (error) {
  const message = String(error.message ?? error).replace(/(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+|spt_[A-Za-z0-9_]+|mp_[A-Za-z0-9_-]{20,}|mpc_[A-Za-z0-9_-]+/g, '[redacted]');
  console.error(`mediapack: ${message}`);
  process.exitCode = 1;
}
