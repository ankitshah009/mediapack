// Read models (VideoView, JobView, OperationView, Quote, JobEvent). Pure reads — never write.
import { INDEXER_VERSION, SCHEMA_VERSION, type ArtifactRef, type JobEvent, type JobView, type OperationView, type Quote, type VideoView } from "../contracts/index.js";
import { AppError } from "./errors.js";
import { iso, type Ctx } from "./ctx.js";

type Row = Record<string, any>;

export function videoView(v: Row, latestJobId: string | null): VideoView {
  return {
    video_id: v.id,
    file_name: v.original_filename,
    state: v.state,
    size_bytes: v.size_bytes == null ? null : Number(v.size_bytes),
    sha256: v.sha256 ?? null,
    duration_ms: v.duration_ms ?? null,
    width: v.width ?? null,
    height: v.height ?? null,
    audio: v.audio,
    reject: v.state === "rejected" ? { code: v.reject_code ?? "MEDIA_UNSUPPORTED", message: v.reject_message ?? "Video was rejected." } : null,
    created_at: iso(v.created_at)!,
    latest_job_id: latestJobId,
  };
}

export function quoteView(ctx: Ctx, q: Row, jobId: string, videoId: string): Quote {
  return {
    schema_version: SCHEMA_VERSION,
    quote_id: q.id,
    job_id: jobId,
    video_id: videoId,
    source_sha256: q.source_sha256,
    amount_minor: q.amount_minor,
    currency: q.currency,
    payment_mode: q.payment_mode,
    expires_at: iso(q.expires_at)!,
    pack_ttl_seconds: q.pack_ttl_seconds,
    limits: { searches: q.limit_searches, frames: q.limit_frames, clip_ms: q.limit_clip_ms, text_chars: q.limit_text_chars },
    indexer_version: q.indexer_version ?? INDEXER_VERSION,
    terms_hash: q.terms_hash,
    purchase_url: `${ctx.cfg.publicOrigin}/v1/jobs/${jobId}/purchase`,
  };
}

export function artifactRef(a: Row, sourceSha: string, url?: { url: string; expires_at: string }): ArtifactRef {
  const isClip = a.kind === "clip";
  const ck = String(a.cache_key ?? "");
  const fm = /:frame:(\d+)$/.exec(ck);
  const cm = /:clip:(\d+)-(\d+):/.exec(ck);
  return {
    artifact_id: a.id,
    kind: a.kind,
    sha256: a.sha256,
    content_type: a.content_type,
    source_sha256: sourceSha,
    requested_ms: isClip ? { start: cm ? Number(cm[1]) : a.start_ms, end: cm ? Number(cm[2]) : a.end_ms } : { start: fm ? Number(fm[1]) : a.frame_ms },
    actual_ms: isClip ? { start: a.start_ms, end: a.end_ms } : { start: a.frame_ms },
    ...(a.width != null ? { width: a.width } : {}),
    ...(a.height != null ? { height: a.height } : {}),
    ...(a.duration_ms != null ? { duration_ms: a.duration_ms } : {}),
    ...(url ? { url: url.url, url_expires_at: url.expires_at } : {}),
  };
}

export function operationView(o: Row): OperationView {
  return {
    operation_id: o.id,
    kind: o.kind,
    request_id: o.request_id,
    state: o.state,
    input: o.input ?? {},
    result: o.result ?? null,
    error: o.state === "failed" ? { code: o.error_code ?? "WORKER_FAILED", message: o.error_message ?? "Operation failed." } : null,
    created_at: iso(o.created_at)!,
    updated_at: iso(o.updated_at)!,
  };
}

export async function latestJobId(ctx: Ctx, videoId: string): Promise<string | null> {
  const r = await ctx.sql`select id from jobs where video_id = ${videoId}::uuid order by created_at desc limit 1`;
  return r[0]?.id ?? null;
}

export async function loadVideo(ctx: Ctx, clientId: string, videoId: string): Promise<Row> {
  if (!/^[0-9a-f-]{36}$/i.test(videoId)) throw new AppError("NOT_FOUND", "Video not found.");
  const r = await ctx.sql`select * from videos where id = ${videoId}::uuid and client_id = ${clientId}::uuid`;
  if (!r[0]) throw new AppError("NOT_FOUND", "Video not found.");
  return r[0];
}

export async function getVideoView(ctx: Ctx, clientId: string, videoId: string): Promise<VideoView> {
  const v = await loadVideo(ctx, clientId, videoId);
  return videoView(v, await latestJobId(ctx, videoId));
}

export async function listVideoViews(ctx: Ctx, clientId: string): Promise<VideoView[]> {
  const rows = await ctx.sql`
    select v.*, (select j.id from jobs j where j.video_id = v.id order by j.created_at desc limit 1) as latest_job
    from videos v where v.client_id = ${clientId}::uuid order by v.created_at desc limit 100`;
  return rows.map((v) => videoView(v, v.latest_job ?? null));
}

/** Ownership check for every job route. Returns joined job/quote/video rows. */
export async function loadJob(ctx: Ctx, clientId: string, jobId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new AppError("NOT_FOUND", "Job not found.");
  const r = await ctx.sql`
    select j.*, to_jsonb(q.*) as quote, to_jsonb(v.*) as video
    from jobs j join quotes q on q.id = j.quote_id join videos v on v.id = j.video_id
    where j.id = ${jobId}::uuid and j.client_id = ${clientId}::uuid and v.client_id = ${clientId}::uuid`;
  if (!r[0]) throw new AppError("NOT_FOUND", "Job not found.");
  return r[0];
}

export async function getJobView(ctx: Ctx, clientId: string, jobId: string): Promise<JobView> {
  const j = await loadJob(ctx, clientId, jobId);
  const q = j.quote;
  const [attempt] = await ctx.sql`select 1 from payment_attempts where job_id = ${jobId}::uuid and state in ('submitting','unknown') limit 1`;
  const ops = await ctx.sql`select * from operations where job_id = ${jobId}::uuid order by created_at, id`;
  const paid = j.paid_at != null;
  const payment_state = paid ? "paid" : attempt ? "reconciling" : "unpaid";
  const packExpired = paid && j.pack_expires_at && new Date(j.pack_expires_at) < new Date();
  const state = packExpired ? "expired" : j.state;
  const used = { searches: j.used_searches, frames: j.used_frames, clip_ms: j.used_clip_ms, text_chars: j.used_text_chars };
  const reserved = { searches: j.reserved_searches, frames: j.reserved_frames, clip_ms: j.reserved_clip_ms, text_chars: j.reserved_text_chars };
  const limits = { searches: q.limit_searches, frames: q.limit_frames, clip_ms: q.limit_clip_ms, text_chars: q.limit_text_chars };
  const remaining = {
    searches: Math.max(0, limits.searches - used.searches - reserved.searches),
    frames: Math.max(0, limits.frames - used.frames - reserved.frames),
    clip_ms: Math.max(0, limits.clip_ms - used.clip_ms - reserved.clip_ms),
    text_chars: Math.max(0, limits.text_chars - used.text_chars - reserved.text_chars),
  };
  const quote = quoteView(ctx, q, j.id, j.video_id);
  const { next_action, retry_after_seconds } = nextAction({ state, payment_state, quote, quoteExpired: new Date(q.expires_at) < new Date(), remaining });
  return {
    job_id: j.id,
    video: videoView(j.video, j.id),
    quote,
    payment_state,
    payment_intent_id: j.payment_intent_id ?? null,
    state,
    paid_at: iso(j.paid_at),
    pack_expires_at: iso(j.pack_expires_at),
    used, reserved, remaining,
    operations: ops.map(operationView),
    next_action,
    ...(retry_after_seconds !== undefined ? { retry_after_seconds } : {}),
  };
}

export function purchaseInstructions(quote: Quote): string {
  const body = JSON.stringify({ quote_id: quote.quote_id });
  return [
    `Pay ${(quote.amount_minor / 100).toFixed(2)} ${quote.currency.toUpperCase()} (${quote.payment_mode} mode) by POSTing ${quote.purchase_url} with body ${body} and header X-MediaPack-Token.`,
    `Buyer option 1 (default, sandbox keys): node scripts/mediapack.mjs buy ${quote.job_id}  (uses the installed mppx SDK with MPPX_STRIPE_SECRET_KEY=sk_test_...).`,
    `Buyer option 2 (Link): node scripts/mediapack.mjs buy ${quote.job_id} --via link  (link-cli mpp pay ... --test).`,
  ].join(" ");
}

function nextAction(p: { state: string; payment_state: string; quote: Quote; quoteExpired: boolean; remaining: Record<string, number> }) {
  if (p.payment_state === "reconciling") return { next_action: "Payment outcome is being checked; poll get_job. Do not pay again.", retry_after_seconds: 5 };
  if (p.state === "awaiting_payment") {
    if (p.quoteExpired) return { next_action: "Quote expired; call quote_video again for a fresh quote." };
    return { next_action: purchaseInstructions(p.quote) };
  }
  if (p.state === "paid" || p.state === "indexing") return { next_action: "Indexing in progress; poll get_job.", retry_after_seconds: 5 };
  if (p.state === "ready") return { next_action: "Ready: call search_video, then get_frames / get_clip for the evidence you need." };
  if (p.state === "failed") return { next_action: "Indexing failed. Payment is preserved; recovery is manual (refund). Do not buy another pack." };
  return { next_action: "Pack expired; upload and quote again to buy a new pack." };
}

export async function getEvents(ctx: Ctx, clientId: string, jobId: string, after: number, limit = 200): Promise<JobEvent[]> {
  const j = await loadJob(ctx, clientId, jobId);
  const rows = await ctx.sql`
    select id, kind, operation_id, details, created_at from job_events
    where video_id = ${j.video_id}::uuid and (job_id is null or job_id = ${jobId}::uuid) and id > ${after}
    order by id limit ${Math.min(limit, 500)}`;
  return rows.map((r) => ({ id: Number(r.id), kind: r.kind, operation_id: r.operation_id ?? null, details: r.details ?? {}, created_at: iso(r.created_at)! }));
}
