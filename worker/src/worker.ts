// One manifest -> one WorkResult -> one Primitive reply. Every path ends in a delivered result or a non-zero exit.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { SCHEMA_VERSION, WorkRequest, WorkResult, type ErrorCode } from "./contracts/index.js";
import { ACTION_DEADLINE_MS, ACTIONS, type ActionDeps } from "./actions.js";
import { redact, toWorkerError, WorkerError } from "./errors.js";
import { OpenAISearch, OpenAIVision, type AsrModel, type SearchModel, type VisionModel } from "./models.js";
import { WhisperCppAsr } from "./local-asr.js";
import type { ResultSink } from "./sink.js";
import type { MediaStore } from "./store.js";

export const WorkerManifest = z.object({
  work_request: WorkRequest,
  reply_email_id: z.string().min(1).max(200),
  worker_token: z.string().min(1),
  control_base_url: z.string().url(),
});
export type WorkerManifest = z.infer<typeof WorkerManifest>;

export interface ModelFactories { vision?: () => VisionModel; asr?: () => AsrModel; search?: () => SearchModel }

export interface ExecuteDeps {
  store: MediaStore;
  sink: ResultSink;
  models?: ModelFactories;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  deadlineMs?: number;
}

export function log(msg: string, extra: Record<string, unknown> = {}): void {
  // Structured, secret-free stderr logs (Blaxel captures process stdout/stderr).
  process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), msg, ...extra }, (_key, value) => typeof value === "string" ? redact(value) : value)}\n`);
}

function lazy<T>(f: () => T): () => T { let v: T | undefined; return () => (v ??= f()); }

/** Run the action and build the WorkResult (never throws for action failures). */
export async function executeRequest(req: WorkRequest, deps: Omit<ExecuteDeps, "sink">): Promise<WorkResult> {
  const started = Date.now();
  const workDir = await mkdtemp(join(tmpdir(), `mp-${req.operation_id.slice(0, 8)}-`));
  const ac = new AbortController();
  const deadline = deps.deadlineMs ?? ACTION_DEADLINE_MS[req.action];
  const timer = setTimeout(() => ac.abort(new WorkerError("WORKER_FAILED", `action exceeded ${deadline} ms deadline`, true)), deadline);
  const l = deps.log ?? log;
  const d: ActionDeps = {
    store: deps.store, workDir, signal: ac.signal, log: l,
    vision: lazy(deps.models?.vision ?? (() => new OpenAIVision())),
    asr: lazy(deps.models?.asr ?? (() => new WhisperCppAsr({ workDir }))),
    search: lazy(deps.models?.search ?? (() => new OpenAISearch())),
  };
  const base = { schema_version: SCHEMA_VERSION, kind: "work_result" as const, operation_id: req.operation_id, generation: req.generation };
  try {
    l("action start", { op: req.operation_id, gen: req.generation, action: req.action });
    const aborted = new Promise<never>((_, rej) => ac.signal.addEventListener("abort", () => rej(ac.signal.reason), { once: true }));
    const out = await Promise.race([ACTIONS[req.action](req, d), aborted]);
    const runtime = Date.now() - started;
    l("action ok", { op: req.operation_id, action: req.action, runtime_ms: runtime });
    return WorkResult.parse({
      ...base, status: "succeeded", result: out.result, usage: out.usage, artifacts: out.artifacts,
      provider_usage: { ...out.provider_usage, runtime_ms: runtime },
    });
  } catch (e) {
    const err = toWorkerError(e);
    l("action failed", { op: req.operation_id, action: req.action, code: err.code, retryable: err.retryable, error: err.message });
    return WorkResult.parse({
      ...base, status: "failed", artifacts: [],
      error: { code: err.code, message: redact(err.message).slice(0, 500), retryable: err.retryable },
      provider_usage: { runtime_ms: Date.now() - started },
    });
  } finally {
    clearTimeout(timer);
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Execute and deliver. Returns the delivered result; throws only if delivery itself failed. */
export async function executeManifest(m: WorkerManifest, deps: ExecuteDeps): Promise<WorkResult> {
  const result = await executeRequest(m.work_request, deps);
  const r = await deps.sink.deliver(m.reply_email_id, result);
  (deps.log ?? log)("result delivered", { op: result.operation_id, status: result.status, reply_id: r.id, replayed: r.replayed });
  return result;
}

/** Best-effort extraction of identifiers from an invalid manifest so we can still report failure. */
export function salvageIds(raw: unknown): { operation_id: string; generation: number; reply_email_id: string } | null {
  const o = raw as { reply_email_id?: unknown; work_request?: { operation_id?: unknown; generation?: unknown } } | null;
  const op = o?.work_request?.operation_id, gen = o?.work_request?.generation, reply = o?.reply_email_id;
  if (typeof op === "string" && z.string().uuid().safeParse(op).success && Number.isInteger(gen) && (gen as number) > 0 && typeof reply === "string" && reply) {
    return { operation_id: op, generation: gen as number, reply_email_id: reply };
  }
  return null;
}

export function failedResult(operationId: string, generation: number, code: ErrorCode, message: string, retryable: boolean): WorkResult {
  return WorkResult.parse({
    schema_version: SCHEMA_VERSION, kind: "work_result", operation_id: operationId, generation, status: "failed", artifacts: [],
    error: { code, message, retryable },
  });
}
