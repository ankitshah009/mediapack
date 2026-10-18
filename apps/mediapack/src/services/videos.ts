// Upload reservation, completion (enqueue probe), quote freezing, abandoned-upload sweeper.
import { z } from "zod";
import {
  CreateVideoRequest, INDEXER_VERSION, INPUT_LIMITS, PACK, SCHEMA_VERSION, hashCanonical, type Quote, type VideoView,
} from "../contracts/index.js";
import { AppError } from "./errors.js";
import { uuidFrom } from "./crypto.js";
import { background, iso, type Ctx } from "./ctx.js";
import { kickOutbox } from "./outbox.js";
import { latestJobId, loadVideo, quoteView, videoView } from "./views.js";

const EXT: Record<string, string> = { "video/mp4": "mp4", "video/webm": "webm" };

export async function createVideo(ctx: Ctx, clientId: string, input: z.infer<typeof CreateVideoRequest>) {
  const id = uuidFrom("video", clientId, input.request_id);
  const objectKey = `${id}/source.${EXT[input.content_type]}`;
  const { row, created } = await ctx.sql.begin(async (tx) => {
    await tx`select id from clients where id = ${clientId}::uuid for update`; // serialize per-client cap checks
    const existing = await tx`select * from videos where id = ${id}::uuid`;
    if (existing[0]) {
      const e = existing[0];
      if (e.client_id !== clientId || e.original_filename !== input.file_name || Number(e.declared_size_bytes) !== input.size_bytes || e.object_key !== objectKey) {
        throw new AppError("IDEMPOTENCY_CONFLICT", "This request_id was already used with a different request.");
      }
      return { row: e, created: false };
    }
    const [mine] = await tx`
      select count(*)::int as c from videos v
      where v.client_id = ${clientId}::uuid and v.state in ('uploading','probing','ready') and v.upload_expires_at > now()
        and not exists (select 1 from jobs j where j.video_id = v.id and j.paid_at is not null)`;
    if (mine!.c >= INPUT_LIMITS.maxUnpaidUploadsPerClient) {
      throw new AppError("INPUT_LIMIT_EXCEEDED", `At most ${INPUT_LIMITS.maxUnpaidUploadsPerClient} unpaid uploads per client; buy or wait for existing uploads to expire (1 hour).`, { status: 429, retryAfter: 300 });
    }
    const [tot] = await tx`
      select coalesce(sum(v.declared_size_bytes),0)::bigint as s from videos v
      where v.state in ('uploading','probing','ready') and v.upload_expires_at > now()
        and not exists (select 1 from jobs j where j.video_id = v.id and j.paid_at is not null)`;
    if (Number(tot!.s) + input.size_bytes > ctx.cfg.unpaidStorageCapBytes) {
      throw new AppError("INPUT_LIMIT_EXCEEDED", "Service-wide unpaid storage is full; try again later.", { status: 503, retryAfter: 600, retryable: true });
    }
    const [ins] = await tx`
      insert into videos (id, client_id, original_filename, object_key, declared_size_bytes, upload_expires_at)
      values (${id}::uuid, ${clientId}::uuid, ${input.file_name}, ${objectKey}, ${input.size_bytes},
              now() + make_interval(secs => ${INPUT_LIMITS.uploadTtlSeconds}))
      returning *`;
    await tx`select app_event(${id}::uuid, null, null, 'video.created', ${tx.json({ size_bytes: input.size_bytes, content_type: input.content_type })})`;
    return { row: ins!, created: true };
  });
  const video = videoView(row, await latestJobId(ctx, id));
  let upload = null;
  if (row.state === "uploading") {
    const u = await ctx.storage.createUpload(row.object_key, input.content_type);
    upload = { method: u.method, url: u.url, headers: u.headers, expires_at: new Date(Math.min(Date.now() + u.expires_in_seconds * 1000, new Date(row.upload_expires_at).getTime() + 3600_000)).toISOString() };
  }
  return { created, body: { video_id: id, state: video.state, upload, video, next_action: "PUT the file to upload.url with upload.headers, then call complete_upload." } };
}

export async function completeUpload(ctx: Ctx, clientId: string, videoId: string) {
  const v = await loadVideo(ctx, clientId, videoId);
  if (v.state === "uploading") {
    if (new Date(v.upload_expires_at) < new Date()) throw new AppError("UPLOAD_INCOMPLETE", "The upload reservation expired; create a new video.", { retryable: false });
    const st = await ctx.storage.stat(v.object_key);
    if (!st || st.size <= 0) throw new AppError("UPLOAD_INCOMPLETE", "No uploaded object found yet; finish the PUT first.", { nextAction: "complete_upload", retryAfter: 2 });
    if (st.size > INPUT_LIMITS.maxBytes) {
      await ctx.storage.remove([v.object_key]).catch(() => {});
      throw new AppError("INPUT_LIMIT_EXCEEDED", `Uploaded object exceeds ${INPUT_LIMITS.maxBytes} bytes.`);
    }
  } else if (v.state === "expired") {
    throw new AppError("UPLOAD_INCOMPLETE", "The upload expired; create a new video.", { retryable: false });
  }
  const [r] = await ctx.sql`select enqueue_probe(${videoId}::uuid, ${clientId}::uuid) as op`;
  kickOutbox(ctx);
  const view = await loadVideo(ctx, clientId, videoId);
  const video = videoView(view, await latestJobId(ctx, videoId));
  return {
    video,
    operation_id: r!.op as string | null,
    next_action: video.state === "ready" ? "Video is ready; call quote_video." : video.state === "rejected" ? "Video was rejected; see reject." : "Probing; poll get_video.",
    ...(video.state === "probing" ? { retry_after_seconds: 3 } : {}),
  };
}

/** Freeze terms + pre-create the pending job. Idempotent: an open quote for the video is returned as-is. */
export async function quoteVideo(ctx: Ctx, clientId: string, videoId: string): Promise<{ quote: Quote; created: boolean }> {
  const v = await loadVideo(ctx, clientId, videoId);
  if (v.state === "rejected") throw new AppError("MEDIA_UNSUPPORTED", v.reject_message ?? "Video was rejected by preflight.");
  if (v.state !== "ready") throw new AppError("VIDEO_NOT_READY", "The video has not passed preflight yet.", { nextAction: "get_video", retryAfter: 3 });
  return ctx.sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${"quote:" + videoId}))`;
    const open = await tx`
      select q.*, j.id as job_id, j.paid_at from quotes q join jobs j on j.quote_id = q.id
      where q.video_id = ${videoId}::uuid and j.client_id = ${clientId}::uuid and (j.paid_at is not null or q.expires_at > now())
      order by (j.paid_at is not null) desc, q.created_at desc limit 1`;
    if (open[0]) return { quote: quoteView(ctx, open[0], open[0].job_id, videoId), created: false };
    const fresh = (await tx`select * from videos where id = ${videoId}::uuid`)[0]!;
    const terms = {
      schema_version: SCHEMA_VERSION,
      video_id: videoId,
      source_sha256: fresh.sha256 as string,
      media: { size_bytes: Number(fresh.size_bytes), duration_ms: fresh.duration_ms, width: fresh.width, height: fresh.height, rotation: fresh.rotation, audio: fresh.audio },
      indexer_version: INDEXER_VERSION,
      amount_minor: PACK.amountMinor,
      currency: PACK.currency,
      payment_mode: ctx.cfg.paymentsMode,
      limits: PACK.limits,
      pack_ttl_seconds: PACK.ttlSeconds,
      expires_at: new Date(Date.now() + PACK.quoteTtlSeconds * 1000).toISOString(),
    };
    const frozen = { ...terms, terms_hash: hashCanonical(terms) };
    const [ids] = await tx`select * from create_quote_and_job(${clientId}::uuid, ${videoId}::uuid, ${tx.json(frozen)})`;
    const [q] = await tx`select * from quotes where id = ${ids!.quote_id}::uuid`;
    return { quote: quoteView(ctx, q!, ids!.job_id, videoId), created: true };
  });
}

/** Expire abandoned unpaid uploads (> 1 hour, no live quote, no payment) and delete their objects. */
export async function sweepExpiredUploads(ctx: Ctx): Promise<number> {
  const rows = await ctx.sql`
    update videos v set state = 'expired', updated_at = now()
    where v.state in ('uploading','probing','ready') and v.upload_expires_at < now()
      and not exists (select 1 from jobs j join quotes q on q.id = j.quote_id
                      where j.video_id = v.id and (j.paid_at is not null or q.expires_at > now()
                        or exists (select 1 from payment_attempts a where a.job_id = j.id and a.state in ('submitting','unknown','succeeded'))))
    returning v.id, v.object_key`;
  if (rows.length) await ctx.storage.remove(rows.map((r) => r.object_key)).catch((e) => console.error("[sweep] remove failed", e.message));
  await ctx.sql`update jobs set state = 'expired', updated_at = now() where paid_at is not null and pack_expires_at < now() and state in ('ready','paid','indexing')`;
  return rows.length;
}

export { iso, background };
