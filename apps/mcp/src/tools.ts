import { createHash, randomUUID } from "node:crypto";
import type { MCPServer } from "mcp-use";
import { z } from "zod";
import { ApiError, createApi, localError, type ApiOptions, type JsonObject, type ToolContext } from "./api.js";

const RequestId = z.string().uuid().optional().describe("Caller-generated UUID; reuse it for retries. Omitted operation IDs are derived from the inputs. Supply this for create_video to make a lost-response retry safe.");
const Id = z.string().uuid();
const schemas = {
  create_video: z.object({ file_name: z.string().min(1).max(200), size_bytes: z.number().int().positive().max(100 * 1024 * 1024), content_type: z.enum(["video/mp4", "video/webm"]), request_id: RequestId }),
  complete_upload: z.object({ video_id: Id, request_id: RequestId }),
  get_video: z.object({ video_id: Id }),
  quote_video: z.object({ video_id: Id, request_id: RequestId }),
  get_job: z.object({ job_id: Id }),
  search_video: z.object({ job_id: Id, query: z.string().min(3).max(500), max_results: z.number().int().min(1).max(3).default(3), request_id: RequestId }),
  get_frames: z.object({ job_id: Id, timestamps_ms: z.array(z.number().int().nonnegative()).min(1).max(8), request_id: RequestId }),
  get_clip: z.object({ job_id: Id, start_ms: z.number().int().nonnegative(), end_ms: z.number().int().positive(), request_id: RequestId }).refine((a) => a.end_ms > a.start_ms && a.end_ms - a.start_ms <= 15_000, "Clip must end after its start and last no more than 15 seconds."),
  get_pack: z.object({ job_id: Id }),
};
export type ToolName = keyof typeof schemas;

/** Keep retry IDs byte-for-byte compatible with the existing MediaPack tools. */
export function uuidFrom(...parts: string[]): string {
  const h = createHash("sha256").update(parts.join("\u0000")).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const s = h.subarray(0, 16).toString("hex");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

const specs: Record<ToolName, { description: string; readOnly: boolean }> = {
  create_video: { description: "Reserve an MP4/WebM upload, at most 100 MiB and 180 s. PUT the raw bytes to upload.url with upload.headers, then call complete_upload. Supply request_id for safe create retries.", readOnly: false },
  complete_upload: { description: "Confirm the signed upload PUT finished; queues the probe. Poll get_video until ready.", readOnly: false },
  get_video: { description: "Read a video's upload/probe state and verified metadata.", readOnly: true },
  quote_video: { description: "Freeze a ready video's test-mode price, allowances and pending job. Follow the returned purchase URL over HTTP; this tool never makes a payment.", readOnly: false },
  get_job: { description: "Read payment/index state, operations, results and remaining allowance. Poll after pending search/frame/clip responses. Payment reconciling means keep polling; never pay again.", readOnly: true },
  search_video: { description: "Search a paid indexed video for visible actions or speech. Uses one distinct search. Pending means poll get_job; no matches is a valid result. Observations cannot establish root cause.", readOnly: false },
  get_frames: { description: "Request source frames at timestamps in milliseconds (up to 8). New frames consume the allowance; repeats are free. Pending means poll get_job. Completed results include short-lived artifact URLs.", readOnly: false },
  get_clip: { description: "Export an H.264 MP4 clip between start_ms and end_ms, at most 15 seconds. Pending means poll get_job. Returns a short-lived authorized URL when done.", readOnly: false },
  get_pack: { description: "Read the accumulated pack, receipt, searches, artifacts with short-lived URLs and usage. Generates no new work.", readOnly: true },
};

function result(body: JsonObject, summary?: string) {
  return { content: [{ type: "text" as const, text: summary ?? JSON.stringify(body) }], structuredContent: body };
}
const record = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

export async function callTool(name: ToolName, input: unknown, ctx: ToolContext, options: ApiOptions) {
  try {
    const api = createApi(options, ctx);
    const enhanceArtifacts = async (body: JsonObject) => {
      if (!record(body.result) || !Array.isArray(body.result.artifacts)) return body;
      const artifacts = await Promise.all(body.result.artifacts.map(async (artifact: unknown) => {
        if (!record(artifact) || typeof artifact.artifact_id !== "string") return artifact;
        const access = await api(`/v1/artifacts/${encodeURIComponent(artifact.artifact_id)}/access`);
        return { ...artifact, url: access.body.url, url_expires_at: access.body.expires_at };
      }));
      const first = artifacts.find(record);
      return { ...body, result: { ...body.result, artifacts }, ...(name === "get_clip" && first ? { access: { url: first.url, expires_at: first.url_expires_at } } : {}) };
    };
    switch (name) {
      case "create_video": {
        const a = schemas.create_video.parse(input);
        const { body } = await api("/v1/videos", { ...a, request_id: a.request_id ?? randomUUID() });
        return result(body);
      }
      case "complete_upload": {
        const a = schemas.complete_upload.parse(input);
        return result((await api(`/v1/videos/${a.video_id}/complete`, { request_id: a.request_id ?? uuidFrom("complete", a.video_id) })).body);
      }
      case "get_video": {
        const a = schemas.get_video.parse(input);
        const video = (await api(`/v1/videos/${a.video_id}`)).body;
        const pending = video.state === "uploading" || video.state === "probing";
        const next = video.state === "ready" ? "Ready: call quote_video." : pending ? "Not ready yet; poll get_video." : "Video rejected or expired; inspect its state and reject details before uploading again.";
        return result({ video, next_action: next, ...(pending ? { retry_after_seconds: 3 } : {}) });
      }
      case "quote_video": {
        const a = schemas.quote_video.parse(input);
        const quote = (await api(`/v1/videos/${a.video_id}/quotes`, { request_id: a.request_id ?? uuidFrom("quote", a.video_id) })).body;
        const next = `Pay ${quote.amount_minor} minor units ${quote.currency} (${quote.payment_mode} mode) by POSTing ${quote.purchase_url} with body ${JSON.stringify({ quote_id: quote.quote_id })} and header X-MediaPack-Token. Use node scripts/mediapack.mjs buy ${quote.job_id}; for Link add --via link. Then poll get_job. If payment is reconciling, do not pay again.`;
        return result({ quote, next_action: next });
      }
      case "get_job": {
        const a = schemas.get_job.parse(input);
        const job = (await api(`/v1/jobs/${a.job_id}`)).body;
        const packExpired = job.state === "expired" || (typeof job.pack_expires_at === "string" && Date.parse(job.pack_expires_at) <= Date.now());
        if (!packExpired && Array.isArray(job.operations)) {
          job.operations = await Promise.all(job.operations.map((operation: unknown) => record(operation) && operation.state === "succeeded" ? enhanceArtifacts(operation) : operation));
        }
        return result(job);
      }
      case "get_pack": {
        const a = schemas.get_pack.parse(input);
        return result((await api(`/v1/jobs/${a.job_id}/pack`)).body);
      }
      default: {
        let jobId: string;
        let path: string;
        let payload: JsonObject;
        if (name === "search_video") {
          const a = schemas.search_video.parse(input);
          jobId = a.job_id; path = "searches";
          payload = { query: a.query, max_results: a.max_results, request_id: a.request_id ?? uuidFrom("search", a.job_id, a.query.trim(), String(a.max_results)) };
        } else if (name === "get_frames") {
          const a = schemas.get_frames.parse(input);
          jobId = a.job_id; path = "frames";
          payload = { timestamps_ms: a.timestamps_ms, request_id: a.request_id ?? uuidFrom("frames", a.job_id, JSON.stringify([...new Set(a.timestamps_ms)].sort((x, y) => x - y))) };
        } else {
          const a = schemas.get_clip.parse(input);
          jobId = a.job_id; path = "clips";
          payload = { start_ms: a.start_ms, end_ms: a.end_ms, request_id: a.request_id ?? uuidFrom("clip", a.job_id, String(a.start_ms), String(a.end_ms)) };
        }
        const r = await api(`/v1/jobs/${jobId}/${path}`, payload);
        const done = r.body.state === "succeeded";
        const failed = r.body.state === "failed";
        const next = done ? "Done." : failed ? "Operation failed; inspect error. Poll get_job before retrying work." : "Pending: poll get_job in a few seconds.";
        const body = { ...r.body, next_action: next, ...(!done && !failed ? { retry_after_seconds: Math.max(1, Number(r.retryAfter) || 5) } : {}) };
        return result(done && name !== "search_video" ? await enhanceArtifacts(body) : body);
      }
    }
  } catch (error) {
    const body = error instanceof ApiError ? error.body : error instanceof z.ZodError ? localError("BAD_REQUEST", "Invalid tool input.", error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")) : localError("INTERNAL", "The MCP proxy could not complete this request.", "Inspect the MediaPack API status and retry this same tool call.", true);
    return { ...result(body), isError: true as const };
  }
}

export function registerTools(server: MCPServer, options: ApiOptions) {
  for (const name of Object.keys(schemas) as ToolName[]) {
    server.tool({
      name, description: specs[name].description,
      inputSchema: schemas[name], outputSchema: z.looseObject({}),
      annotations: { readOnlyHint: specs[name].readOnly, destructiveHint: false, openWorldHint: false },
      ...(name === "get_job" ? { view: { name: "search-results", prefersBorder: false } } : {}),
    } as never, (async (input: unknown, ctx: ToolContext) => callTool(name, input, ctx, options)) as never);
  }
}
