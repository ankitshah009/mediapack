// Canonical wire contracts (CONTRACTS.md). Shared by REST routes, MCP tools, the CLI, the worker and the React app.
import { createHash } from "node:crypto";
import { z } from "zod";

export const SCHEMA_VERSION = "mediapack.v1" as const;
export const INDEXER_VERSION = "video-index-v1" as const;

// ── Product configuration (CONTRACTS §1) ──
export const PACK = {
  amountMinor: 50,
  currency: "usd",
  ttlSeconds: 86_400,
  quoteTtlSeconds: 600,
  limits: { searches: 3, frames: 8, clip_ms: 15_000, text_chars: 8_000 },
} as const;

export const INPUT_LIMITS = {
  maxBytes: 50 * 1024 * 1024,
  maxDurationMs: 180_000,
  maxLongEdge: 1920,
  maxShortEdge: 1080,
  contentTypes: ["video/mp4", "video/webm"] as const,
  uploadTtlSeconds: 3600,
  maxUnpaidUploadsPerClient: 3,
  clientTtlSeconds: 48 * 3600,
} as const;

export const INDEX_LIMITS = {
  sampleIntervalMs: 2000,
  maxBaselineFrames: 90,
  maxInternalFrames: 96,
  imagesPerVisionCall: 12,
  maxVisionCalls: 8,
  visionConcurrency: 2,
  maxMatches: 3,
} as const;

// ── Errors (CONTRACTS §8) ──
export const ErrorCode = z.enum([
  "UNAUTHORIZED", "UPLOAD_INCOMPLETE", "MEDIA_UNSUPPORTED", "INPUT_LIMIT_EXCEEDED", "VIDEO_NOT_READY",
  "QUOTE_EXPIRED", "PAYMENT_REQUIRED", "PAYMENT_RECONCILING", "INDEX_NOT_READY", "ALLOWANCE_EXCEEDED",
  "IDEMPOTENCY_CONFLICT", "MODEL_UNAVAILABLE", "TRANSCRIPTION_FAILED", "WORKER_FAILED", "PACK_EXPIRED",
  "NOT_FOUND", "BAD_REQUEST", "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorBody = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    retryable: z.boolean(),
    retry_after_seconds: z.number().int().optional(),
    job_id: z.string().uuid().optional(),
    next_action: z.string().optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

// ── Requests ──
const RequestId = z.string().uuid().describe("Caller-generated UUID; repeat it to retry safely");

export const CreateVideoRequest = z.object({
  request_id: RequestId,
  file_name: z.string().min(1).max(200),
  size_bytes: z.number().int().positive().max(INPUT_LIMITS.maxBytes),
  content_type: z.enum(INPUT_LIMITS.contentTypes),
});
export const CompleteUploadRequest = z.object({ request_id: RequestId });
export const QuoteRequest = z.object({ request_id: RequestId });
export const PurchaseRequest = z.object({ quote_id: z.string().uuid() });
export const SearchRequest = z.object({
  request_id: RequestId,
  query: z.string().min(3).max(500),
  max_results: z.number().int().min(1).max(INDEX_LIMITS.maxMatches).default(3),
});
export const FramesRequest = z.object({
  request_id: RequestId,
  timestamps_ms: z.array(z.number().int().nonnegative()).min(1).max(PACK.limits.frames),
});
export const ClipRequest = z.object({
  request_id: RequestId,
  start_ms: z.number().int().nonnegative(),
  end_ms: z.number().int().positive(),
}).refine((r) => r.end_ms > r.start_ms, "end_ms must be after start_ms")
  .refine((r) => r.end_ms - r.start_ms <= PACK.limits.clip_ms, `clip longer than ${PACK.limits.clip_ms} ms`);

// ── Quote (CONTRACTS §3) ──
export const Limits = z.object({
  searches: z.number().int(), frames: z.number().int(), clip_ms: z.number().int(), text_chars: z.number().int(),
});
export const Quote = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  quote_id: z.string().uuid(),
  job_id: z.string().uuid(),
  video_id: z.string().uuid(),
  source_sha256: z.string(),
  amount_minor: z.number().int(),
  currency: z.string(),
  payment_mode: z.enum(["test", "live"]),
  expires_at: z.string(),
  pack_ttl_seconds: z.number().int(),
  limits: Limits,
  indexer_version: z.string(),
  terms_hash: z.string(),
  purchase_url: z.string(),
});
export type Quote = z.infer<typeof Quote>;

// ── Search result (CONTRACTS §3) ──
export const Match = z.object({
  match_id: z.string(),
  start_ms: z.number().int(),
  end_ms: z.number().int(),
  description: z.string(),
  modalities: z.array(z.enum(["visual", "speech"])),
  frame_refs: z.array(z.string()),
  transcript_refs: z.array(z.string()),
  transcript_excerpt: z.string().optional(),
  evidence_status: z.enum(["supported", "partial"]),
});
export const SearchResult = z.object({
  query: z.string(),
  answer: z.string(),
  matches: z.array(Match),
  coverage: z.object({
    audio: z.enum(["available", "absent", "failed"]),
    visual_sample_interval_ms: z.number().int(),
    limitations: z.array(z.string()),
  }),
});
export type SearchResult = z.infer<typeof SearchResult>;

export const ArtifactRef = z.object({
  artifact_id: z.string().uuid(),
  kind: z.enum(["frame", "clip"]),
  sha256: z.string(),
  content_type: z.string(),
  source_sha256: z.string(),
  requested_ms: z.object({ start: z.number().int(), end: z.number().int().optional() }),
  actual_ms: z.object({ start: z.number().int(), end: z.number().int().optional() }),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  duration_ms: z.number().int().optional(),
  url: z.string().optional(),
  url_expires_at: z.string().optional(),
});
export type ArtifactRef = z.infer<typeof ArtifactRef>;

// ── Read models served by GET routes (consumed by the React app, MCP tools and the CLI) ──
export const VideoView = z.object({
  video_id: z.string().uuid(),
  file_name: z.string(),
  state: z.enum(["uploading", "probing", "ready", "rejected", "expired"]),
  size_bytes: z.number().int().nullable(),
  sha256: z.string().nullable(),
  duration_ms: z.number().int().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  audio: z.enum(["unknown", "present", "absent"]),
  reject: z.object({ code: z.string(), message: z.string() }).nullable(),
  created_at: z.string(),
  latest_job_id: z.string().uuid().nullable(),
});
export type VideoView = z.infer<typeof VideoView>;

export const OperationView = z.object({
  operation_id: z.string().uuid(),
  kind: WorkActionSchema(),
  request_id: z.string().uuid(),
  state: z.enum(["queued", "dispatched", "running", "succeeded", "failed"]),
  input: z.record(z.string(), z.unknown()),
  result: z.record(z.string(), z.unknown()).nullable(),   // SearchResult for search_video; {artifacts: ArtifactRef[]} for extracts
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type OperationView = z.infer<typeof OperationView>;

export const JobView = z.object({
  job_id: z.string().uuid(),
  video: VideoView,
  quote: Quote,
  payment_state: z.enum(["unpaid", "reconciling", "paid"]),
  payment_intent_id: z.string().nullable(),
  state: z.enum(["awaiting_payment", "paid", "indexing", "ready", "failed", "expired"]),
  paid_at: z.string().nullable(),
  pack_expires_at: z.string().nullable(),
  used: Limits,
  reserved: Limits,
  remaining: Limits,
  operations: z.array(OperationView),
  next_action: z.string(),
  retry_after_seconds: z.number().int().optional(),
});
export type JobView = z.infer<typeof JobView>;

export const JobEvent = z.object({
  id: z.number().int(),
  kind: z.string(),        // e.g. quote.issued, payment.verified, primitive.request_sent, worker.launched, operation.succeeded
  operation_id: z.string().uuid().nullable(),
  details: z.record(z.string(), z.unknown()),
  created_at: z.string(),  // runtime time — never a video timestamp
});
export type JobEvent = z.infer<typeof JobEvent>;

function WorkActionSchema() {
  return z.enum(["probe_video", "index_video", "search_video", "extract_frames", "extract_clip"]);
}

// ── Primitive envelopes (CONTRACTS §6) ──
export const WorkAction = z.enum(["probe_video", "index_video", "search_video", "extract_frames", "extract_clip"]);
export type WorkAction = z.infer<typeof WorkAction>;

export const WorkRequest = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  kind: z.literal("work_request"),
  operation_id: z.string().uuid(),
  job_id: z.string().uuid().nullable(),
  video_id: z.string().uuid(),
  action: WorkAction,
  source_sha256: z.string().nullable(),
  terms_hash: z.string().nullable(),
  generation: z.number().int().positive(),
  media_ref: z.object({ object_key: z.string() }),
  input: z.record(z.string(), z.unknown()),
  reply_to_operation: z.string().uuid(),
});
export type WorkRequest = z.infer<typeof WorkRequest>;

export const Usage = z.object({
  searches: z.number().int().nonnegative().default(0),
  frames: z.number().int().nonnegative().default(0),
  clip_ms: z.number().int().nonnegative().default(0),
  text_chars: z.number().int().nonnegative().default(0),
});
export type Usage = z.infer<typeof Usage>;

export const WorkResult = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  kind: z.literal("work_result"),
  operation_id: z.string().uuid(),
  generation: z.number().int().positive(),
  status: z.enum(["succeeded", "failed"]),
  result: z.record(z.string(), z.unknown()).optional(),   // action-specific, validated by the control service
  usage: Usage.optional(),
  artifacts: z.array(z.object({ artifact_id: z.string().uuid(), sha256: z.string() })).default([]),
  error: z.object({ code: ErrorCode, message: z.string(), retryable: z.boolean() }).optional(),
  provider_usage: z.record(z.string(), z.number()).optional(), // model tokens, ASR seconds, runtime — not caller allowance
});
export type WorkResult = z.infer<typeof WorkResult>;

// ── Canonical hashing ──
/** Deterministic JSON (sorted keys) so hashes are stable across processes. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}
export const sha256Hex = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export const hashCanonical = (v: unknown) => sha256Hex(canonicalJson(v));

/** Evidence prose allowance counts Unicode code points (CONTRACTS §7). */
export const codePoints = (s: string | undefined) => (s ? [...s].length : 0);
