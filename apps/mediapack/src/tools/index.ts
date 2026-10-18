// MCP tools: thin wrappers over the same services as the REST routes. Auth: Authorization: Bearer <capability>.
import type { MCPServer } from "mcp-use";
import { z } from "zod";
import { JobView, OperationView } from "../contracts/index.js";
import { authCapability } from "../services/clients.js";
import type { Ctx } from "../services/ctx.js";
import { AppError, toAppError } from "../services/errors.js";
import { uuidFrom } from "../services/crypto.js";
import { artifactAccessForClient, getPack, requestClip, requestFrames, requestSearch } from "../services/operations.js";
import { completeUpload, createVideo, quoteVideo } from "../services/videos.js";
import { getJobView, getVideoView, purchaseInstructions } from "../services/views.js";

interface ToolCtx { request?: { header(name: string): string | undefined }; req?: { header(name: string): string | undefined } }

const RequestId = z.string().uuid().optional().describe("Caller-generated UUID so retries are safe. Optional: derived from the inputs when omitted.");
const Loose = z.looseObject({});
const annotations = (readOnly: boolean) => ({ readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false });

async function clientOf(ctx: Ctx, t: ToolCtx): Promise<string> {
  const h = (t.request ?? t.req)?.header("authorization");
  const cap = h && /^bearer\s+/i.test(h) ? h.replace(/^bearer\s+/i, "").trim() : undefined;
  const a = await authCapability(ctx, cap);
  if (!a) throw new AppError("UNAUTHORIZED", "Missing or invalid MediaPack capability. Configure the MCP server header Authorization: Bearer <capability> (node scripts/mediapack.mjs bootstrap).");
  return a.id;
}

const text = (t: string) => ({ type: "text" as const, text: t });
function out(summary: string, structured: Record<string, unknown>, extra: unknown[] = []) {
  return { content: [text(summary), ...extra] as never, structuredContent: structured };
}
function fail(e: unknown) {
  const err = toAppError(e);
  return { isError: true as const, content: [text(JSON.stringify(err.body()))] };
}
const safe = <A extends unknown[]>(fn: (...a: A) => Promise<unknown>) => async (...a: A) => { try { return (await fn(...a)) as never; } catch (e) { return fail(e) as never; } };

export function registerTools(server: MCPServer, ctx: Ctx) {
  // The build bundles this view; production registration must not depend on source files existing.
  const resultsView = { view: { name: "search-results", prefersBorder: false } };

  server.tool({
    name: "create_video",
    description: "Reserve an upload for one video (MP4/WebM, <=50 MiB, <=180 s). Returns a signed upload target: PUT the raw file bytes to upload.url with upload.headers, then call complete_upload.",
    inputSchema: z.object({
      file_name: z.string().min(1).max(200), size_bytes: z.number().int().positive(),
      content_type: z.enum(["video/mp4", "video/webm"]), request_id: RequestId,
    }),
    outputSchema: Loose, annotations: annotations(false),
  }, safe(async (a, t: ToolCtx) => {
    const client = await clientOf(ctx, t);
    const { body } = await createVideo(ctx, client, { ...a, request_id: a.request_id ?? crypto.randomUUID() } as never);
    return out(`Video ${body.video_id} reserved. ${body.next_action}`, body);
  }));

  server.tool({
    name: "complete_upload",
    description: "Tell MediaPack the PUT finished. Checks the stored object and queues the preflight probe. Then poll get_video until state is ready.",
    inputSchema: z.object({ video_id: z.string().uuid(), request_id: RequestId }),
    outputSchema: Loose, annotations: annotations(false),
  }, safe(async (a, t: ToolCtx) => {
    const r = await completeUpload(ctx, await clientOf(ctx, t), a.video_id);
    return out(`Video is ${r.video.state}. ${r.next_action}`, r);
  }));

  server.tool({
    name: "get_video",
    description: "Read upload/probe state and verified media metadata for a video.",
    inputSchema: z.object({ video_id: z.string().uuid() }),
    outputSchema: Loose, annotations: annotations(true),
  }, safe(async (a, t: ToolCtx) => {
    const v = await getVideoView(ctx, await clientOf(ctx, t), a.video_id);
    const next = v.state === "ready" ? "Ready: call quote_video." : v.state === "rejected" ? `Rejected: ${v.reject?.message}` : "Not ready yet; poll again.";
    return out(`Video ${v.state}. ${next}`, { video: v, next_action: next, ...(v.state === "uploading" || v.state === "probing" ? { retry_after_seconds: 3 } : {}) });
  }));

  server.tool({
    name: "quote_video",
    description: "Freeze the terms (price, allowances, 24 h pack) for a ready video and pre-create the pending job. Payment is made over HTTP (see next_action), never through this tool.",
    inputSchema: z.object({ video_id: z.string().uuid(), request_id: RequestId }),
    outputSchema: Loose, annotations: annotations(false),
  }, safe(async (a, t: ToolCtx) => {
    const { quote } = await quoteVideo(ctx, await clientOf(ctx, t), a.video_id);
    const next = purchaseInstructions(quote);
    return out(`Quote ${quote.quote_id} for job ${quote.job_id}: ${(quote.amount_minor / 100).toFixed(2)} ${quote.currency.toUpperCase()} (${quote.payment_mode}). ${next}`, { quote, next_action: next });
  }));

  server.tool({
    name: "get_job",
    description: "Payment state, indexing state, operations and their results, remaining allowance. Poll this after search_video/get_frames/get_clip return pending.",
    inputSchema: z.object({ job_id: z.string().uuid() }),
    outputSchema: JobView.loose(), annotations: annotations(true), ...resultsView,
  } as never, safe(async (a: { job_id: string }, t: ToolCtx) => {
    const job = await getJobView(ctx, await clientOf(ctx, t), a.job_id);
    return out(`Job ${job.state} (payment ${job.payment_state}). ${job.next_action}`, job as never);
  }));

  const opOut = (kind: string, r: { status: 200 | 202; operation: z.infer<typeof OperationView> }) => {
    const done = r.operation.state === "succeeded";
    const next = done ? "Done." : r.operation.state === "failed" ? "Operation failed; see error." : "Pending: poll get_job in a few seconds.";
    return { done, next, structured: { ...r.operation, next_action: next, ...(done || r.operation.state === "failed" ? {} : { retry_after_seconds: 5 }) } };
  };

  server.tool({
    name: "search_video",
    description: "Search the indexed video for spoken content or visible actions. Counts one of the pack's distinct searches. Returns 202-style pending until done; matches cite transcript/frame evidence and may be empty (valid no-match).",
    inputSchema: z.object({ job_id: z.string().uuid(), query: z.string().min(3).max(500), max_results: z.number().int().min(1).max(3).default(3), request_id: RequestId }),
    outputSchema: OperationView.extend({ next_action: z.string(), retry_after_seconds: z.number().int().optional() }).loose(),
    annotations: annotations(false),
  } as never, safe(async (a: { job_id: string; query: string; max_results: number; request_id?: string }, t: ToolCtx) => {
    const client = await clientOf(ctx, t);
    const rid = a.request_id ?? uuidFrom("search", a.job_id, a.query.trim(), String(a.max_results));
    const o = opOut("search", await requestSearch(ctx, client, a.job_id, { request_id: rid, query: a.query, max_results: a.max_results }));
    const res = o.structured.result as { answer?: string; matches?: unknown[] } | null;
    return out(o.done ? `${res?.answer ?? ""} (${res?.matches?.length ?? 0} match(es))` : o.next, o.structured);
  }));

  server.tool({
    name: "get_frames",
    description: "Retrieve source frames at the given timestamps (ms). Each newly delivered frame counts against the pack's frame allowance; repeats are free. Returns MCP image content when ready.",
    inputSchema: z.object({ job_id: z.string().uuid(), timestamps_ms: z.array(z.number().int().nonnegative()).min(1).max(8), request_id: RequestId }),
    outputSchema: Loose, annotations: annotations(false),
  }, safe(async (a, t: ToolCtx) => {
    const client = await clientOf(ctx, t);
    const rid = a.request_id ?? uuidFrom("frames", a.job_id, JSON.stringify([...new Set(a.timestamps_ms)].sort((x, y) => x - y)));
    const o = opOut("frames", await requestFrames(ctx, client, a.job_id, { request_id: rid, timestamps_ms: a.timestamps_ms }));
    if (!o.done) return out(o.next, o.structured);
    const refs = ((o.structured.result as { artifacts?: { artifact_id: string; actual_ms: { start: number }; requested_ms: { start: number }; sha256: string }[] } | null)?.artifacts) ?? [];
    const images: unknown[] = [];
    for (const ref of refs) {
      const [row] = await ctx.sql`select object_key, content_type from artifacts where id = ${ref.artifact_id}::uuid`;
      if (!row) continue;
      const bytes = await ctx.storage.download(row.object_key, 4 * 1024 * 1024);
      images.push(text(`Frame at ${(ref.actual_ms.start / 1000).toFixed(3)} s (requested ${ref.requested_ms.start} ms) sha256:${ref.sha256.slice(0, 12)}`));
      images.push({ type: "image", data: bytes.toString("base64"), mimeType: row.content_type });
    }
    return out(`${refs.length} frame(s) delivered.`, o.structured, images);
  }));

  server.tool({
    name: "get_clip",
    description: "Export a source clip (re-encoded H.264 MP4) for [start_ms, end_ms], at most 15 s total across the pack. Returns an authorized, short-lived URL when ready.",
    inputSchema: z.object({ job_id: z.string().uuid(), start_ms: z.number().int().nonnegative(), end_ms: z.number().int().positive(), request_id: RequestId }),
    outputSchema: Loose, annotations: annotations(false),
  }, safe(async (a, t: ToolCtx) => {
    const client = await clientOf(ctx, t);
    const rid = a.request_id ?? uuidFrom("clip", a.job_id, String(a.start_ms), String(a.end_ms));
    const o = opOut("clip", await requestClip(ctx, client, a.job_id, { request_id: rid, start_ms: a.start_ms, end_ms: a.end_ms }));
    if (!o.done) return out(o.next, o.structured);
    const ref = (o.structured.result as { artifacts?: { artifact_id: string }[] } | null)?.artifacts?.[0];
    const access = ref ? await artifactAccessForClient(ctx, client, ref.artifact_id) : undefined;
    return out(`Clip ready${access ? `: ${access.url}` : ""}`, { ...o.structured, ...(access ? { access: { url: access.url, expires_at: access.expires_at } } : {}) });
  }));

  server.tool({
    name: "get_pack",
    description: "Read the accumulated pack manifest (receipt, searches, delivered artifacts with URLs, usage). Generates no new work.",
    inputSchema: z.object({ job_id: z.string().uuid() }),
    outputSchema: Loose, annotations: annotations(true),
  }, safe(async (a, t: ToolCtx) => {
    const pack = await getPack(ctx, await clientOf(ctx, t), a.job_id);
    return out(`Pack for job ${a.job_id}: ${pack.artifacts.length} artifact(s), ${pack.matches.length} match(es).`, pack as never);
  }));
}
