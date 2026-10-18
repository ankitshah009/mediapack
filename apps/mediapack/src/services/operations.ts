// Operation requests (search / frames / clips / pack) and verified application of WorkResults.
import { z } from "zod";
import {
  ClipRequest, FramesRequest, INDEX_LIMITS, INDEXER_VERSION, INPUT_LIMITS, SearchRequest, SearchResult, codePoints,
  hashCanonical, type ArtifactRef, type OperationView, type WorkResult,
} from "../contracts/index.js";
import { AppError } from "./errors.js";
import { uuidFrom, sha256 } from "./crypto.js";
import type { Ctx } from "./ctx.js";
import { kickOutbox } from "./outbox.js";
import { opPrefix } from "./workerTokens.js";
import { artifactRef, loadJob, operationView } from "./views.js";

type Row = Record<string, any>;
export const SEARCH_TEXT_RESERVE = 2500;
export const CLIP_TOLERANCE_MS = 50; // documented one-frame measurement tolerance
const SAMPLE_LIMITATION = "Brief events between sampled frames may be missed.";
const ARTIFACT_URL_TTL = 600;

const normQuery = (q: string) => q.trim().replace(/\s+/g, " ").toLowerCase();

// ───────────────────────── requests ─────────────────────────

async function opByRequest(ctx: Ctx, jobId: string, kind: string, requestId: string) {
  const [o] = await ctx.sql`select * from operations where job_id = ${jobId}::uuid and kind = ${kind} and request_id = ${requestId}::uuid`;
  return o as Row | undefined;
}

async function reserve(
  ctx: Ctx, clientId: string, jobId: string, kind: string, requestId: string, input: Row, hashSource: unknown,
  use: { searches?: number; frames?: number; clip_ms?: number; text_chars?: number },
) {
  try {
    const [r] = await ctx.sql`
      select * from reserve_operation(${clientId}::uuid, ${jobId}::uuid, ${kind}, ${requestId}::uuid, ${ctx.sql.json(input as never)},
        ${hashCanonical(hashSource)}, ${use.searches ?? 0}, ${use.frames ?? 0}, ${use.clip_ms ?? 0}, ${use.text_chars ?? 0})`;
    if (r!.created) kickOutbox(ctx);
    const [op] = await ctx.sql`select * from operations where id = ${r!.operation_id}::uuid`;
    return { op: op!, created: r!.created as boolean };
  } catch (e) {
    throw (e instanceof AppError ? e : mapReserveError(e, jobId));
  }
}
import { toAppError } from "./errors.js";
const mapReserveError = (e: unknown, jobId: string) => toAppError(e, jobId);

function respond(op: Row): { status: 200 | 202; operation: OperationView } {
  return { status: op.state === "succeeded" ? 200 : 202, operation: operationView(op) };
}

export async function requestSearch(ctx: Ctx, clientId: string, jobId: string, req: z.infer<typeof SearchRequest>) {
  const job = await loadJob(ctx, clientId, jobId);
  const query = req.query.trim();
  if (!(await opByRequest(ctx, jobId, "search_video", req.request_id))) {
    assertPaidActive(job);
    const [dup] = await ctx.sql`
      select * from operations where job_id = ${jobId}::uuid and kind = 'search_video' and state = 'succeeded'
        and lower(regexp_replace(btrim(input->>'query'), '[[:space:]]+', ' ', 'g')) = ${normQuery(query)}
        and (input->>'max_results')::int = ${req.max_results}
      order by created_at limit 1`;
    if (dup) return respond(dup); // a distinct question is charged once
  }
  const q = job.quote;
  const remainingText = q.limit_text_chars - job.used_text_chars - job.reserved_text_chars;
  const reserveText = Math.min(SEARCH_TEXT_RESERVE, Math.max(0, remainingText));
  if (reserveText <= 0 && job.paid_at && !(await opByRequest(ctx, jobId, "search_video", req.request_id))) {
    throw new AppError("ALLOWANCE_EXCEEDED", "No evidence-text allowance remains in this pack.", { jobId, nextAction: "get_job" });
  }
  const input = { query, max_results: req.max_results, max_text_chars: reserveText };
  const { op } = await reserve(ctx, clientId, jobId, "search_video", req.request_id, input, { query, max_results: req.max_results },
    { searches: 1, text_chars: reserveText });
  return respond(op);
}

async function syntheticSucceeded(ctx: Ctx, job: Row, kind: string, requestId: string, input: Row, hashSource: unknown, result: Row) {
  await ctx.sql`
    insert into operations (job_id, video_id, kind, request_id, input, input_hash, state, result)
    values (${job.id}::uuid, ${job.video_id}::uuid, ${kind}, ${requestId}::uuid, ${ctx.sql.json(input as never)}, ${hashCanonical(hashSource)}, 'succeeded', ${ctx.sql.json(result as never)})
    on conflict (scope_id, kind, request_id) do nothing`;
  await ctx.sql`select app_event(${job.video_id}::uuid, ${job.id}::uuid, null, 'operation.cache_hit', ${ctx.sql.json({ kind })})`;
  const op = await opByRequest(ctx, job.id, kind, requestId);
  if (op!.input_hash !== hashCanonical(hashSource)) throw new AppError("IDEMPOTENCY_CONFLICT", "This request_id was already used with a different request.");
  return respond(op!);
}

function assertPaidActive(job: Row) {
  if (!job.paid_at) throw new AppError("PAYMENT_REQUIRED", "This job has not been paid.", { jobId: job.id, nextAction: "purchase" });
  if (new Date(job.pack_expires_at) < new Date()) throw new AppError("PACK_EXPIRED", "The 24-hour pack has expired. Upload and quote again to buy a new pack.", { jobId: job.id });
}

export async function requestFrames(ctx: Ctx, clientId: string, jobId: string, req: z.infer<typeof FramesRequest>) {
  const job = await loadJob(ctx, clientId, jobId);
  const existing = await opByRequest(ctx, jobId, "extract_frames", req.request_id);
  const full = [...new Set(req.timestamps_ms)].sort((a, b) => a - b);
  const hashSource = { timestamps_ms: full };
  if (existing) {
    if (existing.input_hash !== hashCanonical(hashSource)) throw new AppError("IDEMPOTENCY_CONFLICT", "This request_id was already used with a different request.");
    return respond(existing);
  }
  assertPaidActive(job);
  if (job.state !== "ready") throw new AppError("INDEX_NOT_READY", "The video is still being indexed.", { jobId, retryAfter: 5, nextAction: "get_job" });
  const dur = job.video.duration_ms as number;
  if (full.some((t) => t > dur)) throw new AppError("BAD_REQUEST", `timestamps_ms must be within the video duration (${dur} ms).`);
  const sha = job.video.sha256 as string;
  const keys = full.map((t) => `${sha}:frame:${t}`);
  const cached = await ctx.sql`select * from artifacts where video_id = ${job.video_id}::uuid and job_id = ${jobId}::uuid and kind = 'frame' and cache_key = any(${ctx.sql.array(keys)})`;
  const have = new Set(cached.map((a) => a.cache_key));
  const missing = full.filter((t) => !have.has(`${sha}:frame:${t}`));
  if (!missing.length) {
    const byKey = new Map(cached.map((a) => [a.cache_key, a]));
    const artifacts = keys.map((k) => artifactRef(byKey.get(k)!, sha));
    return syntheticSucceeded(ctx, job, "extract_frames", req.request_id, { timestamps_ms: full }, hashSource, { artifacts });
  }
  const { op } = await reserve(ctx, clientId, jobId, "extract_frames", req.request_id,
    { timestamps_ms: missing, request_timestamps_ms: full }, hashSource, { frames: missing.length });
  return respond(op);
}

export async function requestClip(ctx: Ctx, clientId: string, jobId: string, req: z.infer<typeof ClipRequest>) {
  const job = await loadJob(ctx, clientId, jobId);
  const hashSource = { start_ms: req.start_ms, end_ms: req.end_ms };
  const existing = await opByRequest(ctx, jobId, "extract_clip", req.request_id);
  if (existing) {
    if (existing.input_hash !== hashCanonical(hashSource)) throw new AppError("IDEMPOTENCY_CONFLICT", "This request_id was already used with a different request.");
    return respond(existing);
  }
  assertPaidActive(job);
  if (job.state !== "ready") throw new AppError("INDEX_NOT_READY", "The video is still being indexed.", { jobId, retryAfter: 5, nextAction: "get_job" });
  const dur = job.video.duration_ms as number;
  if (req.end_ms > dur) throw new AppError("BAD_REQUEST", `end_ms must be within the video duration (${dur} ms).`);
  const sha = job.video.sha256 as string;
  const key = `${sha}:clip:${req.start_ms}-${req.end_ms}:h264crf23:${INDEXER_VERSION}`;
  const [hit] = await ctx.sql`select * from artifacts where video_id = ${job.video_id}::uuid and job_id = ${jobId}::uuid and kind = 'clip' and cache_key = ${key}`;
  if (hit) return syntheticSucceeded(ctx, job, "extract_clip", req.request_id, hashSource, hashSource, { artifacts: [artifactRef(hit, sha)] });
  const { op } = await reserve(ctx, clientId, jobId, "extract_clip", req.request_id, hashSource, hashSource, { clip_ms: req.end_ms - req.start_ms });
  return respond(op);
}

export async function getOperation(ctx: Ctx, clientId: string, jobId: string, opId: string) {
  await loadJob(ctx, clientId, jobId);
  if (!/^[0-9a-f-]{36}$/i.test(opId)) throw new AppError("NOT_FOUND", "Operation not found.");
  const [o] = await ctx.sql`select * from operations where id = ${opId}::uuid and job_id = ${jobId}::uuid`;
  if (!o) throw new AppError("NOT_FOUND", "Operation not found.");
  return operationView(o);
}

/** Authorize + mint a short-lived URL. Accepts an artifact id (entitled, delivered) or the owner's video id (original upload). */
export async function artifactAccessForClient(ctx: Ctx, clientId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError("NOT_FOUND", "Artifact not found.");
  const expires_at = new Date(Date.now() + ARTIFACT_URL_TTL * 1000).toISOString();
  const [src] = await ctx.sql`select object_key, state from videos where id = ${id}::uuid and client_id = ${clientId}::uuid`;
  if (src) {
    if (src.state === "expired") throw new AppError("NOT_FOUND", "Artifact not found.");
    return { url: await ctx.storage.createDownloadUrl(src.object_key, ARTIFACT_URL_TTL), expires_at, kind: "source" as const };
  }
  const [a] = await ctx.sql`
    select a.*, v.sha256 as source_sha, j.paid_at, j.pack_expires_at
    from artifacts a join videos v on v.id = a.video_id join jobs j on j.id = a.job_id
    where a.id = ${id}::uuid and v.client_id = ${clientId}::uuid and j.client_id = ${clientId}::uuid and a.kind in ('frame','clip') and a.delivered`;
  if (!a) throw new AppError("NOT_FOUND", "Artifact not found.");
  if (!a.paid_at) throw new AppError("PAYMENT_REQUIRED", "This job has not been paid.");
  if (new Date(a.pack_expires_at) < new Date()) throw new AppError("PACK_EXPIRED", "The pack has expired.");
  const url = await ctx.storage.createDownloadUrl(a.object_key, ARTIFACT_URL_TTL);
  return { url, expires_at, kind: a.kind as "frame" | "clip", artifact: artifactRef(a, a.source_sha, { url, expires_at }) };
}

/** Pack manifest: accumulated results + authorized artifact URLs + receipt reference. Generates no work. */
export async function getPack(ctx: Ctx, clientId: string, jobId: string) {
  const job = await loadJob(ctx, clientId, jobId);
  if (!job.paid_at) throw new AppError("PAYMENT_REQUIRED", "This job has not been paid.", { jobId, nextAction: "purchase" });
  const ops = await ctx.sql`select * from operations where job_id = ${jobId}::uuid and kind <> 'index_video' order by created_at, id`;
  const arts = await ctx.sql`select * from artifacts where job_id = ${jobId}::uuid and kind in ('frame','clip') and delivered order by created_at, id`;
  const expired = new Date(job.pack_expires_at) < new Date();
  let urls: Record<string, string> = {};
  if (!expired && arts.length) urls = await ctx.storage.createDownloadUrls(arts.map((a) => a.object_key), ARTIFACT_URL_TTL);
  const exp = new Date(Date.now() + ARTIFACT_URL_TTL * 1000).toISOString();
  const q = job.quote;
  return {
    schema_version: "mediapack.v1",
    job_id: jobId,
    source_sha256: job.video.sha256,
    indexer_version: q.indexer_version,
    source: { video_id: job.video_id, sha256: job.video.sha256, duration_ms: job.video.duration_ms, file_name: job.video.original_filename },
    receipt: {
      payment_intent_id: job.payment_intent_id, method: "stripe", reference: job.payment_intent_id, status: "success", amount_minor: q.amount_minor, currency: q.currency,
      mode: q.payment_mode, paid_at: new Date(job.paid_at).toISOString(), terms_hash: q.terms_hash,
    },
    pack_expires_at: new Date(job.pack_expires_at).toISOString(),
    usage: { searches: job.used_searches, frames: job.used_frames, clip_ms: job.used_clip_ms, text_chars: job.used_text_chars },
    limits: { searches: q.limit_searches, frames: q.limit_frames, clip_ms: q.limit_clip_ms, text_chars: q.limit_text_chars },
    matches: ops.filter((o) => o.kind === "search_video" && o.state === "succeeded").flatMap((o) => (o.result?.matches ?? []) as unknown[]),
    searches: ops.filter((o) => o.kind === "search_video" && o.state === "succeeded").map((o) => ({ operation_id: o.id, ...o.result })),
    artifacts: expired ? [] : arts.map((a) => artifactRef(a, job.video.sha256, urls[a.object_key] ? { url: urls[a.object_key]!, expires_at: exp } : undefined)),
    operations: ops.map(operationView),
  };
}

// ───────────────────────── applying results ─────────────────────────

class ResultInvalid extends Error {}
const bad = (msg: string): never => { throw new ResultInvalid(msg); };

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const Int = z.number().int();
const ProbeRes = z.object({
  accepted: z.boolean(),
  sha256: Hex64.nullish(), size_bytes: Int.positive().nullish(), duration_ms: Int.nullish(), width: Int.positive().nullish(), height: Int.positive().nullish(),
  rotation: Int.nullish(), audio: z.enum(["present", "absent"]).nullish(),
  reject_code: z.string().max(64).optional(), reject_message: z.string().max(500).optional(),
});
const IndexFrame = z.object({ record_id: z.string().min(1).max(64), object_key: z.string(), sha256: Hex64, frame_ms: Int.nonnegative(), width: Int.positive(), height: Int.positive() });
const IndexRes = z.object({ index_object_key: z.string(), index_sha256: Hex64, source_sha256: Hex64, frames: z.array(IndexFrame).max(INDEX_LIMITS.maxInternalFrames), audio: z.enum(["available", "absent", "failed"]) });
const IndexFile = z.object({
  indexer_version: z.string(),
  source_sha256: Hex64,
  records: z.array(z.object({
    record_id: z.string().min(1).max(64), kind: z.enum(["frame", "speech"]), start_ms: Int.nonnegative(), end_ms: Int.nonnegative(),
    text: z.string().max(4000), visible_text: z.string().max(4000).nullish(), frame_object_key: z.string().nullish(),
  })).max(5000),
});
const FrameRes = z.object({ frames: z.array(z.object({ requested_ms: Int.nonnegative(), actual_ms: Int.nonnegative(), object_key: z.string(), sha256: Hex64, width: Int.positive(), height: Int.positive(), bytes: Int.positive() })).max(32) });
const ClipRes = z.object({
  clip: z.object({
    requested_start_ms: Int.nonnegative(), requested_end_ms: Int.positive(), actual_start_ms: Int.nonnegative(), actual_end_ms: Int.positive(),
    duration_ms: Int.positive(), object_key: z.string(), sha256: Hex64, width: Int.positive(), height: Int.positive(), bytes: Int.positive(),
  }),
});

const contentTypeFor = (key: string) =>
  /\.png$/i.test(key) ? "image/png" : /\.webp$/i.test(key) ? "image/webp" : /\.mp4$/i.test(key) ? "video/mp4" : /\.json$/i.test(key) ? "application/json" : "image/jpeg";

async function checkKey(ctx: Ctx, op: Row, key: string, expectBytes?: number) {
  if (!key.startsWith(opPrefix(op.video_id, op.id, op.generation)) || key.includes("..")) bad(`object key outside operation prefix: ${key.slice(0, 80)}`);
  const st = await ctx.storage.stat(key);
  if (!st) bad(`object missing: ${key.slice(0, 80)}`);
  if (expectBytes !== undefined && st!.size !== expectBytes) bad(`object size mismatch for ${key.slice(0, 80)}`);
  return st!;
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  const q = [...items];
  await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => { for (let x = q.shift(); x !== undefined; x = q.shift()) await fn(x); }));
}

interface Prepared { result: Row; usage: Row; write?: (tx: any) => Promise<Row> }

async function prepareProbe(ctx: Ctx, op: Row, wr: WorkResult): Promise<Prepared> {
  const r = ProbeRes.safeParse(wr.result);
  if (!r.success) return bad("malformed probe result");
  const p = r.data;
  if (!p.accepted) {
    return { result: { accepted: false, reject_code: p.reject_code ?? "MEDIA_UNSUPPORTED", reject_message: p.reject_message ?? "Unsupported media." }, usage: {} };
  }
  if (!p.sha256 || p.size_bytes == null || p.duration_ms == null || p.width == null || p.height == null || p.rotation == null || !p.audio) return bad("probe result missing fields");
  const [v] = await ctx.sql`select object_key from videos where id = ${op.video_id}::uuid`;
  const st = await ctx.storage.stat(v!.object_key);
  if (!st || st.size !== p.size_bytes) return bad("probe size does not match stored object");
  const long = Math.max(p.width, p.height), short = Math.min(p.width, p.height);
  const reject = (code: string, message: string): Prepared => ({ result: { accepted: false, reject_code: code, reject_message: message }, usage: {} });
  if (p.size_bytes > INPUT_LIMITS.maxBytes) return reject("INPUT_LIMIT_EXCEEDED", "File exceeds 100 MiB.");
  if (p.duration_ms <= 0 || p.duration_ms > INPUT_LIMITS.maxDurationMs) return reject("INPUT_LIMIT_EXCEEDED", "Duration must be at most 180 seconds.");
  if (long > INPUT_LIMITS.maxLongEdge || short > INPUT_LIMITS.maxShortEdge) return reject("INPUT_LIMIT_EXCEEDED", "Dimensions exceed 1920x1080.");
  return { result: { accepted: true, sha256: p.sha256, size_bytes: p.size_bytes, duration_ms: p.duration_ms, width: p.width, height: p.height, rotation: p.rotation, audio: p.audio }, usage: {} };
}

async function prepareIndex(ctx: Ctx, op: Row, wr: WorkResult): Promise<Prepared> {
  const r = IndexRes.safeParse(wr.result);
  if (!r.success) return bad("malformed index result");
  const res = r.data;
  const st = await checkKey(ctx, op, res.index_object_key);
  if (st.size > 8 * 1024 * 1024) bad("index too large");
  const buf = await ctx.storage.download(res.index_object_key, 8 * 1024 * 1024);
  if (sha256(buf) !== res.index_sha256) bad("index sha256 mismatch");
  let file: z.infer<typeof IndexFile>;
  try { file = IndexFile.parse(JSON.parse(buf.toString("utf8"))); } catch { return bad("index file malformed"); }
  if (file.indexer_version !== INDEXER_VERSION) bad(`unexpected indexer_version ${file.indexer_version}`);
  const [v] = await ctx.sql`select duration_ms, sha256 from videos where id = ${op.video_id}::uuid`;
  if (file.source_sha256 !== v!.sha256 || res.source_sha256 !== v!.sha256) bad("index source digest does not match the video");
  const maxT = (v!.duration_ms as number) + 5000;
  const ids = new Set<string>();
  for (const rec of file.records) {
    if (rec.end_ms < rec.start_ms || rec.end_ms > maxT) bad(`record ${rec.record_id} out of range`);
    if (ids.has(rec.record_id)) bad(`duplicate record ${rec.record_id}`);
    ids.add(rec.record_id);
  }
  const frameStats = new Map<string, number>();
  await pool(res.frames, 8, async (f) => { const s = await checkKey(ctx, op, f.object_key); frameStats.set(f.object_key, s.size); });
  const frameIds = new Set<string>();
  const frameKeys = new Set<string>();
  for (const f of res.frames) {
    const record = file.records.find((r) => r.record_id === f.record_id);
    if (!record || record.kind !== "frame" || record.frame_object_key !== f.object_key || record.start_ms !== f.frame_ms) bad(`frame does not match record ${f.record_id}`);
    if (frameIds.has(f.record_id) || frameKeys.has(f.object_key)) bad("duplicate index frame");
    frameIds.add(f.record_id);
    frameKeys.add(f.object_key);
  }
  if (file.records.some((r) => r.kind === "frame" && !frameIds.has(r.record_id))) bad("frame record has no stored image");
  return {
    result: { indexer_version: file.indexer_version, record_count: file.records.length, frame_count: res.frames.length, audio: res.audio },
    usage: {},
    write: async (tx) => {
      const [ia] = await tx`
        insert into artifacts (video_id, job_id, operation_id, kind, object_key, sha256, bytes, content_type, indexer_version)
        values (${op.video_id}::uuid, ${op.job_id}::uuid, ${op.id}::uuid, 'index', ${res.index_object_key}, ${res.index_sha256}, ${buf.length}, 'application/json', ${INDEXER_VERSION})
        returning id`;
      const frameArt = new Map<string, string>();
      for (const f of res.frames) {
        const [fa] = await tx`
          insert into artifacts (video_id, job_id, operation_id, kind, object_key, sha256, bytes, content_type, frame_ms, width, height, indexer_version)
          values (${op.video_id}::uuid, ${op.job_id}::uuid, ${op.id}::uuid, 'index_frame', ${f.object_key}, ${f.sha256}, ${frameStats.get(f.object_key) ?? null},
                  ${contentTypeFor(f.object_key)}, ${f.frame_ms}, ${f.width}, ${f.height}, ${INDEXER_VERSION}) returning id`;
        frameArt.set(f.record_id, fa.id);
      }
      for (const rec of file.records) {
        await tx`
          insert into index_records (video_id, indexer_version, record_id, kind, start_ms, end_ms, text, visible_text, artifact_id)
          values (${op.video_id}::uuid, ${INDEXER_VERSION}, ${rec.record_id}, ${rec.kind}, ${rec.start_ms}, ${rec.end_ms}, ${rec.text}, ${rec.visible_text ?? null}, ${frameArt.get(rec.record_id) ?? null})
          on conflict do nothing`;
      }
      return { indexer_version: file.indexer_version, record_count: file.records.length, frame_count: res.frames.length, audio: res.audio, index_artifact_id: ia.id };
    },
  };
}

/** Trim text to at most `budget` code points, preferring a sentence boundary. */
export function trimToBudget(text: string, budget: number): string {
  if (budget <= 0) return "";
  const chars = [...text];
  if (chars.length <= budget) return text;
  const slice = chars.slice(0, budget).join("");
  let cut = -1;
  const re = /[.!?](?=\s|$)/g;
  for (let m = re.exec(slice); m; m = re.exec(slice)) cut = m.index + 1;
  if (cut > 0) return slice.slice(0, cut);
  const sp = slice.lastIndexOf(" ");
  const base = sp > 0 ? slice.slice(0, sp) : [...slice].slice(0, Math.max(0, budget - 1)).join("");
  return budget > 1 ? [...base].slice(0, budget - 1).join("") + "…" : "";
}

async function prepareSearch(ctx: Ctx, op: Row, wr: WorkResult): Promise<Prepared> {
  const parsed = SearchResult.safeParse(wr.result);
  if (!parsed.success) return bad("malformed search result");
  const sr = parsed.data;
  const maxResults = Math.min(Number(op.input?.max_results ?? INDEX_LIMITS.maxMatches), INDEX_LIMITS.maxMatches);
  const [idx] = await ctx.sql`
    select o.result->>'audio' as audio from operations o where o.job_id = ${op.job_id}::uuid and o.kind = 'index_video' and o.state = 'succeeded'`;
  const audio = (idx?.audio ?? sr.coverage.audio) as "available" | "absent" | "failed";
  const allRefs = [...new Set(sr.matches.flatMap((m) => [...m.frame_refs, ...m.transcript_refs]))].slice(0, 200);
  const recs = allRefs.length
    ? await ctx.sql`select record_id, kind, start_ms, end_ms, text from index_records
                    where video_id = ${op.video_id}::uuid and indexer_version = ${INDEXER_VERSION} and record_id = any(${ctx.sql.array(allRefs)})`
    : [];
  const byId = new Map(recs.map((r) => [r.record_id as string, r]));
  let budget = Math.max(0, Number(op.reserve_text_chars ?? 0));
  const take = (s: string | undefined) => { const t = trimToBudget(s ?? "", budget); budget -= codePoints(t); return t; };
  const answer = take(sr.answer.trim() || "No match found in the indexed evidence.");
  const matches: z.infer<typeof SearchResult>["matches"] = [];
  for (const m of sr.matches) {
    if (matches.length >= maxResults) break;
    const frame_refs = m.frame_refs.filter((id) => byId.get(id)?.kind === "frame");
    const transcript_refs = m.transcript_refs.filter((id) => byId.get(id)?.kind === "speech");
    const valid = [...frame_refs, ...transcript_refs].map((id) => byId.get(id)!);
    if (!valid.length || budget <= 0) continue;
    const dropped = m.frame_refs.length + m.transcript_refs.length - valid.length;
    const speechText = transcript_refs.map((id) => byId.get(id)!.text).join(" ").replace(/\s+/g, " ").trim();
    let excerpt: string | undefined;
    if (transcript_refs.length) {
      const claimed = (m.transcript_excerpt ?? "").replace(/\s+/g, " ").trim();
      excerpt = claimed && speechText.toLowerCase().includes(claimed.toLowerCase()) ? claimed : speechText;
    }
    const description = take(m.description);
    const ex = excerpt ? take(excerpt) : undefined;
    matches.push({
      match_id: `m_${uuidFrom(op.id, String(matches.length)).slice(0, 8)}`,
      start_ms: Math.min(...valid.map((r) => r.start_ms)),
      end_ms: Math.max(...valid.map((r) => r.end_ms)),
      description,
      modalities: [...(frame_refs.length ? ["visual" as const] : []), ...(transcript_refs.length ? ["speech" as const] : [])],
      frame_refs, transcript_refs,
      ...(ex ? { transcript_excerpt: ex } : {}),
      evidence_status: dropped === 0 && m.evidence_status === "supported" ? "supported" : "partial",
    });
  }
  const limitations = [SAMPLE_LIMITATION, ...sr.coverage.limitations.filter((l) => l !== SAMPLE_LIMITATION).map((l) => l.slice(0, 200))].slice(0, 5);
  const result: SearchResult = {
    query: String(op.input?.query ?? sr.query),
    answer,
    matches,
    coverage: { audio, visual_sample_interval_ms: INDEX_LIMITS.sampleIntervalMs, limitations },
  };
  const text_chars = codePoints(answer) + matches.reduce((n, m) => n + codePoints(m.description) + codePoints(m.transcript_excerpt), 0);
  return { result, usage: { searches: 1, text_chars } };
}

async function prepareFrames(ctx: Ctx, op: Row, wr: WorkResult): Promise<Prepared> {
  const r = FrameRes.safeParse(wr.result);
  if (!r.success) return bad("malformed frames result");
  const asked: number[] = op.input.timestamps_ms;
  const got = r.data.frames;
  if (got.length !== asked.length || !asked.every((t) => got.some((f) => f.requested_ms === t))) bad("frames do not match the request");
  const [v] = await ctx.sql`select sha256, duration_ms from videos where id = ${op.video_id}::uuid`;
  for (const f of got) if (f.actual_ms > v!.duration_ms + 1000) bad("frame time beyond duration");
  await pool(got, 8, async (f) => { await checkKey(ctx, op, f.object_key, f.bytes); });
  const sha = v!.sha256 as string;
  const usage = { frames: 0 };
  return {
    result: {}, // filled after insert (needs artifact ids)
    usage,
    write: async (tx) => {
      const refs = new Map<number, Row>();
      for (const f of got) {
        const ck = `${sha}:frame:${f.requested_ms}`;
        let [a] = await tx`
          insert into artifacts (video_id, job_id, operation_id, kind, object_key, sha256, bytes, content_type, frame_ms, width, height, cache_key, indexer_version, delivered)
          values (${op.video_id}::uuid, ${op.job_id}::uuid, ${op.id}::uuid, 'frame', ${f.object_key}, ${f.sha256}, ${f.bytes}, ${contentTypeFor(f.object_key)}, ${f.actual_ms}, ${f.width}, ${f.height}, ${ck}, ${INDEXER_VERSION}, true)
          on conflict (video_id, cache_key) where cache_key is not null do nothing returning *`;
        if (a) usage.frames++;
        else [a] = await tx`select * from artifacts where video_id = ${op.video_id}::uuid and cache_key = ${ck}`;
        refs.set(f.requested_ms, a);
      }
      const full: number[] = op.input.request_timestamps_ms ?? asked;
      const missingCached = full.filter((t) => !refs.has(t));
      if (missingCached.length) {
        const rows = await tx`select * from artifacts where video_id = ${op.video_id}::uuid and job_id = ${op.job_id}::uuid and kind = 'frame' and cache_key = any(${tx.array(missingCached.map((t) => `${sha}:frame:${t}`))})`;
        for (const a of rows) refs.set(Number(/:frame:(\d+)$/.exec(a.cache_key)![1]), a);
      }
      return { artifacts: full.map((t) => artifactRef(refs.get(t)!, sha)) };
    },
  };
}

async function prepareClip(ctx: Ctx, op: Row, wr: WorkResult): Promise<Prepared> {
  const r = ClipRes.safeParse(wr.result);
  if (!r.success) return bad("malformed clip result");
  const c = r.data.clip;
  const askedS: number = op.input.start_ms, askedE: number = op.input.end_ms;
  if (c.requested_start_ms !== askedS || c.requested_end_ms !== askedE) bad("clip does not match the request");
  const reserved = Number(op.reserve_clip_ms);
  if (c.duration_ms > reserved + CLIP_TOLERANCE_MS) bad(`clip duration ${c.duration_ms} ms exceeds reserved ${reserved} ms`);
  if (c.actual_end_ms <= c.actual_start_ms) bad("clip range invalid");
  await checkKey(ctx, op, c.object_key, c.bytes);
  const [v] = await ctx.sql`select sha256 from videos where id = ${op.video_id}::uuid`;
  const sha = v!.sha256 as string;
  const ck = `${sha}:clip:${askedS}-${askedE}:h264crf23:${INDEXER_VERSION}`;
  const usage = { clip_ms: 0 };
  return {
    result: {},
    usage,
    write: async (tx) => {
      let [a] = await tx`
        insert into artifacts (video_id, job_id, operation_id, kind, object_key, sha256, bytes, content_type, start_ms, end_ms, duration_ms, width, height, cache_key, indexer_version, delivered)
        values (${op.video_id}::uuid, ${op.job_id}::uuid, ${op.id}::uuid, 'clip', ${c.object_key}, ${c.sha256}, ${c.bytes}, 'video/mp4', ${c.actual_start_ms}, ${c.actual_end_ms}, ${c.duration_ms}, ${c.width}, ${c.height}, ${ck}, ${INDEXER_VERSION}, true)
        on conflict (video_id, cache_key) where cache_key is not null do nothing returning *`;
      if (a) usage.clip_ms = Math.min(c.duration_ms, reserved);
      else [a] = await tx`select * from artifacts where video_id = ${op.video_id}::uuid and cache_key = ${ck}`;
      return { artifacts: [artifactRef(a, sha)] };
    },
  };
}

export type ApplyOutcome = "completed" | "already_completed" | "stale" | "failed" | "retrying" | "ignored" | "rejected_invalid";

/** Validate a WorkResult against the active generation, storage and ledger, then commit it exactly once. */
export async function applyWorkResult(ctx: Ctx, wr: WorkResult): Promise<{ outcome: ApplyOutcome; detail?: string }> {
  const [op] = await ctx.sql`select * from operations where id = ${wr.operation_id}::uuid`;
  if (!op) return { outcome: "ignored", detail: "unknown operation" };
  if (op.generation !== wr.generation) return { outcome: "stale" };
  if (op.state === "succeeded") return { outcome: "already_completed" };
  if (op.state === "failed") return { outcome: "stale" };

  if (wr.status === "failed") {
    const e = wr.error;
    const [r] = await ctx.sql`select fail_or_retry_operation(${op.id}::uuid, ${op.generation}, ${e?.code ?? "WORKER_FAILED"}, ${e?.message ?? "worker reported failure"}, ${e?.retryable ?? true}) as o`;
    kickOutbox(ctx);
    return { outcome: r!.o === "retrying" ? "retrying" : r!.o === "failed" ? "failed" : "stale" };
  }

  let prep: Prepared;
  try {
    prep = await ({
      probe_video: prepareProbe, index_video: prepareIndex, search_video: prepareSearch,
      extract_frames: prepareFrames, extract_clip: prepareClip,
    } as Record<string, (c: Ctx, o: Row, w: WorkResult) => Promise<Prepared>>)[op.kind]!(ctx, op, wr);
  } catch (e) {
    if (!(e instanceof ResultInvalid)) throw e; // transient (storage etc.): let the caller retry the delivery
    const [r] = await ctx.sql`select fail_or_retry_operation(${op.id}::uuid, ${op.generation}, 'WORKER_FAILED', ${"result rejected: " + e.message}, true) as o`;
    kickOutbox(ctx);
    return { outcome: "rejected_invalid", detail: `${e.message} -> ${r!.o}` };
  }

  const outcome = await ctx.sql.begin(async (tx) => {
    const [cur] = await tx`select generation, state from operations where id = ${op.id}::uuid for update`;
    if (cur!.generation !== op.generation || cur!.state === "failed") return "stale";
    if (cur!.state === "succeeded") return "already_completed";
    const result = prep.write ? await prep.write(tx) : prep.result;
    const [c] = await tx`select complete_operation(${op.id}::uuid, ${op.generation}, ${tx.json(result as never)}, ${tx.json(prep.usage as never)}) as o`;
    return c!.o as string;
  });
  return { outcome: outcome as ApplyOutcome };
}
