// FIXTURE DATA — for local visual checks only (`?fixtures=1`). The UI labels this mode on every screen.
// Only loaded in development builds with the flag set. Match the real REST response envelopes.
import type { JobEvent, JobView, OperationView, VideoView } from "../api/types";
import { ApiError, type PackView } from "../api/client";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SHA = "9f2c1ab47d3e58f60b1c0d9e7a4f2b6c8e1d3a5f7b9c0e2d4f6a8b1c3d5e7f90";
const T0 = Date.parse("2026-10-17T14:02:10Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();

const vid = (n: number, o: Partial<VideoView>): VideoView => ({
  video_id: U(n), file_name: "clip.mp4", state: "ready", size_bytes: 41_000_000, sha256: SHA, duration_ms: 94_000,
  width: 1920, height: 1080, audio: "present", reject: null, created_at: iso(0), latest_job_id: null, ...o,
});

export const VIDEOS: VideoView[] = [
  vid(1, { file_name: "product-walkthrough.mp4", latest_job_id: U(101) }),
  vid(2, { file_name: "team-standup.webm", latest_job_id: U(102), audio: "absent", duration_ms: 62_000 }),
  vid(3, { file_name: "quarterly-review.mp4", latest_job_id: U(103), duration_ms: 140_000 }),
  vid(4, { file_name: "screen-capture.mp4", state: "probing", duration_ms: null, width: null, height: null, audio: "unknown", sha256: null }),
  vid(5, { file_name: "long-conference.mp4", state: "rejected", duration_ms: null, width: null, height: null, audio: "unknown", sha256: null,
    reject: { code: "INPUT_LIMIT_EXCEEDED", message: "Duration is 14:02; the limit is 3:00." } }),
  vid(6, { file_name: "fresh-upload.mp4", duration_ms: 48_000 }),
];

const LIM = { searches: 3, frames: 8, clip_ms: 15_000, text_chars: 8_000 };
const quote = (jobN: number, videoN: number, mode: "test" | "live" = "test") => ({
  schema_version: "mediapack.v1" as const, quote_id: U(900 + jobN), job_id: U(jobN), video_id: U(videoN), source_sha256: SHA,
  amount_minor: 50, currency: "usd", payment_mode: mode, expires_at: new Date(Date.now() + 8 * 60_000).toISOString(),
  pack_ttl_seconds: 86_400, limits: LIM, indexer_version: "video-index-v1", terms_hash: "b7e3" + SHA.slice(4),
  purchase_url: `https://mediapack.example.com/v1/jobs/${U(jobN)}/purchase`,
});

const op = (n: number, kind: OperationView["kind"], state: OperationView["state"], input = {}, result: OperationView["result"] = null,
  error: OperationView["error"] = null): OperationView => ({
  operation_id: U(n), kind, request_id: U(n + 5000), state, input, result, error, created_at: iso(20), updated_at: iso(40),
});

const search1 = {
  query: "where does the presenter show the pricing slide?",
  answer: "The pricing slide appears twice: first when the plans are introduced, and again during the Q&A recap.",
  matches: [
    { match_id: "m1", start_ms: 31_000, end_ms: 38_000, description: "A slide titled “Plans & pricing” with three tiers is on screen while the presenter walks through them.",
      modalities: ["visual", "speech"], frame_refs: [], transcript_refs: ["t4"], transcript_excerpt: "…and this is where the three tiers are laid out, starting with the free plan…", evidence_status: "supported" },
    { match_id: "m2", start_ms: 72_000, end_ms: 79_000, description: "Presenter returns to the pricing slide to answer a question about annual billing.",
      modalities: ["speech"], frame_refs: [], transcript_refs: ["t9"], transcript_excerpt: "…if you pay annually it comes out to roughly two months free…", evidence_status: "partial" },
  ],
  coverage: { audio: "available" as const, visual_sample_interval_ms: 2000, limitations: ["Events shorter than 2s may be missed visually"] },
};

const frameArt = (n: number, ms: number) => ({
  artifact_id: U(700 + n), kind: "frame" as const, sha256: SHA.replace(/^../, "a" + n), content_type: "image/jpeg", source_sha256: SHA,
  requested_ms: { start: ms }, actual_ms: { start: ms + 40 }, width: 1920, height: 1080,
});
const clipArt = { artifact_id: U(750), kind: "clip" as const, sha256: SHA.replace(/^../, "c1"), content_type: "video/mp4", source_sha256: SHA,
  requested_ms: { start: 31_000, end: 38_000 }, actual_ms: { start: 30_960, end: 38_000 }, width: 1280, height: 720, duration_ms: 7040 };

function job(n: number, videoN: number, o: Partial<JobView>): JobView {
  const v = VIDEOS.find((x) => x.video_id === U(videoN))!;
  return {
    job_id: U(n), video: v, quote: quote(n, videoN), payment_state: "paid", payment_intent_id: "pi_3Qx9fixtureA1b2C3", state: "ready",
    paid_at: iso(12), pack_expires_at: new Date(Date.now() + 23 * 3600_000).toISOString(),
    used: { searches: 1, frames: 2, clip_ms: 7040, text_chars: 520 }, reserved: { searches: 0, frames: 0, clip_ms: 0, text_chars: 0 },
    remaining: { searches: 2, frames: 6, clip_ms: 7960, text_chars: 7480 }, operations: [], next_action: "Ask a question, or request frames and clips for a match.", ...o,
  };
}

const JOBS: Record<string, JobView> = {
  [U(101)]: job(101, 1, {
    operations: [
      op(11, "index_video", "succeeded"),
      op(12, "search_video", "succeeded", { query: search1.query }, search1 as never),
      op(13, "extract_frames", "succeeded", { timestamps_ms: [31_000, 34_000] }, { artifacts: [frameArt(1, 31_000), frameArt(2, 34_000)] }),
      op(14, "extract_clip", "succeeded", { start_ms: 31_000, end_ms: 38_000 }, { artifacts: [clipArt] }),
    ],
  }),
  [U(102)]: job(102, 2, {
    payment_state: "unpaid", payment_intent_id: null, state: "awaiting_payment", paid_at: null, pack_expires_at: null,
    used: { searches: 0, frames: 0, clip_ms: 0, text_chars: 0 }, remaining: LIM, operations: [],
    next_action: "Pay the quote over MPP (sandbox buyer or Link), then the video is indexed.",
  }),
  [U(103)]: job(103, 3, {
    payment_state: "reconciling", payment_intent_id: null, state: "paid", paid_at: null, pack_expires_at: null,
    used: { searches: 0, frames: 0, clip_ms: 0, text_chars: 0 }, remaining: LIM, operations: [],
    next_action: "Payment outcome is pending. Do not pay again; poll this job.", retry_after_seconds: 5,
  }),
  [U(104)]: job(104, 1, {
    state: "failed", used: { searches: 0, frames: 0, clip_ms: 0, text_chars: 0 }, remaining: LIM,
    operations: [op(21, "index_video", "failed", {}, null, { code: "WORKER_FAILED", message: "Frame sampling crashed on a corrupt segment at 1:12." })],
    next_action: "Indexing failed. Payment is preserved; retry or contact the operator.",
  }),
  [U(105)]: job(105, 1, {
    used: { searches: 3, frames: 8, clip_ms: 15_000, text_chars: 4100 }, remaining: { searches: 0, frames: 0, clip_ms: 0, text_chars: 3900 },
    operations: [op(31, "index_video", "succeeded"), op(32, "search_video", "succeeded", { query: "any mention of refunds" },
      { query: "any mention of refunds", answer: "Nothing in the video speaks to or shows refunds.", matches: [],
        coverage: { audio: "available", visual_sample_interval_ms: 2000, limitations: [] } } as never)],
    next_action: "Allowance exhausted. Buy a new pack to search again.",
  }),
};
const fx = (code: ConstructorParameters<typeof ApiError>[1], message: string, status = 400) => new ApiError(status, code, message);

const EV = (id: number, kind: string, s: number, details: Record<string, unknown> = {}): JobEvent => ({ id, kind, operation_id: null, details, created_at: iso(s) });
const EVENTS: JobEvent[] = [
  EV(1, "quote.issued", 0, { amount_minor: 50 }),
  EV(2, "payment.challenge", 4),
  EV(3, "payment.verified", 12, { payment_intent_id: "pi_3Qx9fixtureA1b2C3", mode: "test" }),
  EV(4, "primitive.request_sent", 13, { action: "index_video", message_id: "em_01FIX" }),
  EV(5, "worker.launched", 19, { generation: 1 }),
  EV(6, "operation.succeeded", 58, { action: "index_video" }),
  EV(7, "primitive.request_sent", 70, { action: "search_video" }),
  EV(8, "operation.succeeded", 82, { action: "search_video" }),
];

export async function fixtureApi(method: string, path: string, _body?: unknown): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 30));
  const [p] = path.split("?");
  let m: RegExpMatchArray | null;
  if (method === "GET" && p === "/v1/videos") return { videos: VIDEOS };
  if (method === "GET" && (m = p.match(/^\/v1\/videos\/([^/]+)$/))) {
    const v = VIDEOS.find((x) => x.video_id === m![1]);
    if (v) return v;
    throw fx("NOT_FOUND", "No such video.", 404);
  }
  if (method === "POST" && (m = p.match(/^\/v1\/videos\/([^/]+)\/quotes$/))) return quote(102, 2);
  if (method === "GET" && (m = p.match(/^\/v1\/jobs\/([^/]+)$/))) {
    const j = JOBS[m[1]];
    if (j) return { ...j, quote: { ...j.quote, expires_at: new Date(Date.now() + 8 * 60_000).toISOString() } };
    throw fx("NOT_FOUND", "No such job.", 404);
  }
  if (method === "GET" && /^\/v1\/jobs\/[^/]+\/events$/.test(p)) {
    const after = Number(new URLSearchParams(path.split("?")[1]).get("after") ?? 0);
    return EVENTS.filter((e) => e.id > after).slice(0, p.includes(U(102)) ? 2 : 99);
  }
  if (method === "GET" && /\/pack$/.test(p)) return { source_sha256: SHA, indexer_version: "video-index-v1", artifacts: [frameArt(1, 31_000), frameArt(2, 34_000), clipArt] } satisfies PackView;
  if (method === "GET" && p.startsWith("/v1/artifacts/")) throw fx("NOT_FOUND", "Fixture mode has no media files.", 404);
  if (method === "POST" && /\/(searches|frames|clips)$/.test(p)) return op(99, "search_video", "queued");
  throw fx("BAD_REQUEST", `Fixture mode does not implement ${method} ${p}.`);
}

export const FIXTURE_JOB_IDS = { paid: U(101), unpaid: U(102), reconciling: U(103), failed: U(104), exhausted: U(105) };
