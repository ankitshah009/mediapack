import type { ErrorBody, JobEvent, JobView, OperationView, Quote, VideoView, ArtifactRef } from "../../../src/contracts/index";

export type { ErrorBody, JobEvent, JobView, OperationView, Quote, VideoView, ArtifactRef };

export class ApiError extends Error {
  code: string;
  status: number;
  retryable: boolean;
  retryAfter?: number;
  nextAction?: string;
  jobId?: string;
  constructor(status: number, code: string, message: string, extra: Partial<ApiError> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = extra.retryable ?? false;
    this.retryAfter = extra.retryAfter;
    this.nextAction = extra.nextAction;
    this.jobId = extra.jobId;
  }
}

export function isFixtures(): boolean {
  if (!import.meta.env?.DEV) return false;
  try {
    const q = new URLSearchParams(window.location.search).get("fixtures");
    if (q === "1") sessionStorage.setItem("mp:fixtures", "1");
    if (q === "0") sessionStorage.removeItem("mp:fixtures");
    return sessionStorage.getItem("mp:fixtures") === "1";
  } catch {
    return false;
  }
}

const TIMEOUT_MS = 30_000;

export async function api<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  if (import.meta.env?.DEV && isFixtures()) {
    const { fixtureApi } = await import("../dev/fixtures");
    return (await fixtureApi(method, path, body)) as T;
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const abort = () => ctl.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  let res: Response;
  let text: string;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
    text = await res.text();
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new ApiError(0, "NETWORK", ctl.signal.aborted ? "The request timed out." : "Could not reach the MediaPack service.", {
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
  let json: unknown = undefined;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON body */
    }
  }
  if (!res.ok) {
    const e = (json as Partial<ErrorBody> | undefined)?.error;
    if (e) {
      throw new ApiError(res.status, e.code, e.message, {
        retryable: e.retryable,
        retryAfter: e.retry_after_seconds,
        nextAction: e.next_action,
        jobId: e.job_id,
      });
    }
    throw new ApiError(res.status, res.status === 401 ? "UNAUTHORIZED" : "INTERNAL", `Request failed (${res.status}).`);
  }
  return json as T;
}

export interface UploadInstructions {
  method: string;
  url: string;
  headers: Record<string, string>;
}
export interface CreatedVideo {
  video_id: string;
  upload: UploadInstructions | null;
  state: VideoView["state"];
  video: VideoView;
  next_action: string;
}
export interface CompletedVideo {
  video: VideoView;
  operation_id: string | null;
  next_action: string;
  retry_after_seconds?: number;
}
export interface AccessUrl {
  url: string;
  expires_at: string;
}
/** GET /v1/jobs/:id/pack — server-assembled manifest. Fields beyond `artifacts` are rendered generically. */
export interface PackView {
  job_id?: string;
  source_sha256?: string;
  terms_hash?: string;
  indexer_version?: string;
  artifacts?: ArtifactRef[];
  [k: string]: unknown;
}

export const Api = {
  bootstrap: () => api<unknown>("POST", "/viewer/bootstrap"),
  pair: (code: string) => api<unknown>("POST", "/viewer/session", { code }),
  videos: async () => (await api<{ videos: VideoView[] }>("GET", "/v1/videos")).videos,
  video: (id: string, signal?: AbortSignal) => api<VideoView>("GET", `/v1/videos/${id}`, undefined, signal),
  createVideo: (b: { request_id: string; file_name: string; size_bytes: number; content_type: string }) =>
    api<CreatedVideo>("POST", "/v1/videos", b),
  completeVideo: async (id: string, request_id: string) =>
    (await api<CompletedVideo>("POST", `/v1/videos/${id}/complete`, { request_id })).video,
  quote: (videoId: string, request_id: string) => api<Quote>("POST", `/v1/videos/${videoId}/quotes`, { request_id }),
  job: (id: string, signal?: AbortSignal) => api<JobView>("GET", `/v1/jobs/${id}`, undefined, signal),
  events: (id: string, after: number, signal?: AbortSignal) =>
    api<JobEvent[]>("GET", `/v1/jobs/${id}/events?after=${after}`, undefined, signal),
  search: (jobId: string, b: { request_id: string; query: string; max_results: number }) =>
    api<OperationView>("POST", `/v1/jobs/${jobId}/searches`, b),
  frames: (jobId: string, b: { request_id: string; timestamps_ms: number[] }) =>
    api<OperationView>("POST", `/v1/jobs/${jobId}/frames`, b),
  clip: (jobId: string, b: { request_id: string; start_ms: number; end_ms: number }) =>
    api<OperationView>("POST", `/v1/jobs/${jobId}/clips`, b),
  pack: (jobId: string) => api<PackView>("GET", `/v1/jobs/${jobId}/pack`),
  access: (artifactId: string) => api<AccessUrl>("GET", `/v1/artifacts/${artifactId}/access`),
};

/** PUT the file to the signed upload URL with real byte progress. */
export function uploadFile(
  up: UploadInstructions,
  file: File,
  onProgress: (loaded: number, total: number) => void,
  signal: AbortSignal,
): Promise<void> {
  if (isFixtures()) return Promise.reject(new ApiError(0, "FIXTURES", "Uploads are disabled in fixture mode."));
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(up.method || "PUT", up.url);
    xhr.timeout = 120_000;
    for (const [k, v] of Object.entries(up.headers ?? {})) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded, e.total);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new ApiError(xhr.status, "UPLOAD_FAILED", `Storage rejected the upload (HTTP ${xhr.status}).`, { retryable: true }));
    xhr.onerror = () => reject(new ApiError(0, "UPLOAD_FAILED", "Upload connection failed.", { retryable: true }));
    xhr.ontimeout = () => reject(new ApiError(0, "UPLOAD_FAILED", "Upload timed out. Retry the same upload.", { retryable: true }));
    xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
    const abort = () => xhr.abort();
    xhr.onloadend = () => signal.removeEventListener("abort", abort);
    if (signal.aborted) return reject(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    xhr.send(file);
  });
}

/** Friendly copy per ErrorCode (CONTRACTS §8). Server message is always shown as the detail. */
export const ERROR_COPY: Record<string, { title: string; hint: string }> = {
  UNAUTHORIZED: { title: "No browser session", hint: "Start a session, or pair this browser with your agent's client." },
  UPLOAD_INCOMPLETE: { title: "Upload not finished", hint: "The file has not fully reached storage. Upload it again." },
  MEDIA_UNSUPPORTED: { title: "Media not supported", hint: "Use an MP4 or WebM with a readable video stream." },
  INPUT_LIMIT_EXCEEDED: { title: "Over the input limit", hint: "Up to 100 MB, 3 minutes, 1920×1080." },
  VIDEO_NOT_READY: { title: "Video still processing", hint: "Verification has not finished yet." },
  QUOTE_EXPIRED: { title: "Quote expired", hint: "Request a fresh quote. Nothing was charged." },
  PAYMENT_REQUIRED: { title: "Payment required", hint: "The agent must pay this quote before the pack unlocks." },
  PAYMENT_RECONCILING: { title: "Payment is reconciling", hint: "Stripe has not confirmed the outcome yet. Do not pay again." },
  INDEX_NOT_READY: { title: "Index not ready", hint: "Indexing is still running. This page updates on its own." },
  ALLOWANCE_EXCEEDED: { title: "Allowance used up", hint: "This pack has no budget left for that request. Buy a new pack to continue." },
  IDEMPOTENCY_CONFLICT: { title: "Request conflict", hint: "That request id was already used with different input." },
  MODEL_UNAVAILABLE: { title: "Model unavailable", hint: "Try again shortly." },
  TRANSCRIPTION_FAILED: { title: "Transcription failed", hint: "Visual search may still work." },
  WORKER_FAILED: { title: "Worker failed", hint: "The work did not finish. Spent allowance is preserved." },
  PACK_EXPIRED: { title: "Pack expired", hint: "The 24-hour pack has ended. Source files may no longer be retrievable." },
  NOT_FOUND: { title: "Not found", hint: "It may belong to another client or have expired." },
  BAD_REQUEST: { title: "Invalid request", hint: "Check the input and try again." },
  INTERNAL: { title: "Service error", hint: "Something broke on our side." },
  NETWORK: { title: "Connection problem", hint: "Check your connection and retry." },
};
