import type { ErrorCode } from "./contracts/index.js";

/** A failure the worker reports to control as a failed WorkResult. Message must be safe to persist (no secrets/URLs). */
export class WorkerError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "WorkerError";
  }
}

export function toWorkerError(err: unknown): WorkerError {
  if (err instanceof WorkerError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new WorkerError("WORKER_FAILED", redact(msg).slice(0, 500), true, { cause: err });
}

/** Strip query strings (signed URL tokens) and bearer-ish tokens from text that may be persisted. */
export function redact(s: string): string {
  return s
    .replace(/(https?:\/\/[^\s?"']+)\?[^\s"']*/g, "$1?<redacted>")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/=-]+/gi, "$1<redacted>")
    .replace(/\b(sk|prim|bl)[-_][A-Za-z0-9_-]{8,}/g, "<redacted-key>");
}
