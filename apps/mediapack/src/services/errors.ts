import type { ErrorBody } from "../contracts/index.js";

export type Code = ErrorBody["error"]["code"];

const STATUS: Record<Code, number> = {
  UNAUTHORIZED: 401, UPLOAD_INCOMPLETE: 409, MEDIA_UNSUPPORTED: 422, INPUT_LIMIT_EXCEEDED: 413,
  VIDEO_NOT_READY: 409, QUOTE_EXPIRED: 410, PAYMENT_REQUIRED: 402, PAYMENT_RECONCILING: 202,
  INDEX_NOT_READY: 409, ALLOWANCE_EXCEEDED: 409, IDEMPOTENCY_CONFLICT: 409, MODEL_UNAVAILABLE: 503,
  TRANSCRIPTION_FAILED: 502, WORKER_FAILED: 502, PACK_EXPIRED: 410, NOT_FOUND: 404, BAD_REQUEST: 400, INTERNAL: 500,
};
const RETRYABLE = new Set<Code>(["PAYMENT_RECONCILING", "INDEX_NOT_READY", "UPLOAD_INCOMPLETE", "MODEL_UNAVAILABLE", "WORKER_FAILED"]);

export interface AppErrorOpts {
  status?: number;
  retryAfter?: number;
  jobId?: string;
  nextAction?: string;
  retryable?: boolean;
}

export class AppError extends Error {
  readonly code: Code;
  readonly status: number;
  readonly opts: AppErrorOpts;
  constructor(code: Code, message: string, opts: AppErrorOpts = {}) {
    super(message);
    this.code = code;
    this.status = opts.status ?? STATUS[code];
    this.opts = opts;
  }
  body(): ErrorBody & { hint: string; next_action: string } {
    return {
      hint: this.message,
      next_action: this.opts.nextAction ?? (this.code === "UNAUTHORIZED" ? "Provide a valid owner capability or pair a browser session." : this.opts.retryable ?? RETRYABLE.has(this.code) ? "Retry the same request with its original request_id after checking the resource status." : "Correct the request or resolve the reported configuration before retrying."),
      error: {
        code: this.code,
        message: this.message,
        retryable: this.opts.retryable ?? RETRYABLE.has(this.code),
        ...(this.opts.retryAfter !== undefined ? { retry_after_seconds: this.opts.retryAfter } : {}),
        ...(this.opts.jobId ? { job_id: this.opts.jobId } : {}),
        ...(this.opts.nextAction ? { next_action: this.opts.nextAction } : {}),
      },
    };
  }
}

const SQL_MESSAGES: Record<string, [Code, string, AppErrorOpts?]> = {
  UNAUTHORIZED: ["NOT_FOUND", "Resource not found."],
  VIDEO_NOT_READY: ["VIDEO_NOT_READY", "The video has not passed preflight yet.", { nextAction: "get_video", retryAfter: 3 }],
  IDEMPOTENCY_CONFLICT: ["IDEMPOTENCY_CONFLICT", "This request_id was already used with a different request."],
  PAYMENT_REQUIRED: ["PAYMENT_REQUIRED", "This job has not been paid.", { nextAction: "purchase" }],
  PACK_EXPIRED: ["PACK_EXPIRED", "The 24-hour pack has expired. Upload and quote again to buy a new pack."],
  INDEX_NOT_READY: ["INDEX_NOT_READY", "The video is still being indexed.", { nextAction: "get_job", retryAfter: 5 }],
  ALLOWANCE_EXCEEDED: ["ALLOWANCE_EXCEEDED", "The remaining allowance in this pack cannot cover the request.", { nextAction: "get_job" }],
  JOB_NOT_FOUND: ["NOT_FOUND", "Job not found."],
  PAYMENT_MISMATCH: ["INTERNAL", "Payment did not match the quoted terms."],
};

/** Convert anything thrown into an AppError (Postgres RAISE EXCEPTION 'CODE' messages are mapped). */
export function toAppError(e: unknown, jobId?: string): AppError {
  if (e instanceof AppError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  const first = msg.split(/[\s:]/)[0] ?? "";
  const m = SQL_MESSAGES[first];
  if (m) return new AppError(m[0], m[1], { ...(m[2] ?? {}), ...(jobId ? { jobId } : {}) });
  console.error("[internal]", e instanceof Error ? (e.stack ?? msg) : msg);
  return new AppError("INTERNAL", "Internal error.", { retryable: false });
}
