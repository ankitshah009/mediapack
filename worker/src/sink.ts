// Result delivery: reply through Primitive to the inbound work-request email. Body = WorkResult JSON (authoritative).
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { client as primitiveClient, type ReceivedEmail } from "@primitivedotdev/sdk";
import type { WorkResult } from "./contracts/index.js";

export const PRIMITIVE_BODY_LIMIT = 262_144;
export const resultIdempotencyKey = (operationId: string, generation: number) => `mp:${operationId}:result:${generation}`;

export interface ResultSink {
  deliver(replyEmailId: string, result: WorkResult): Promise<{ id: string | null; replayed: boolean }>;
}

function body(result: WorkResult): string {
  const text = JSON.stringify(result);
  if (Buffer.byteLength(text, "utf8") > PRIMITIVE_BODY_LIMIT) throw new Error(`WorkResult is ${Buffer.byteLength(text)} bytes; Primitive limit is ${PRIMITIVE_BODY_LIMIT}`);
  return text;
}

async function withRetry<T>(fn: () => Promise<T>, isRetryable: (e: unknown) => boolean, attempts = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (!isRetryable(e) || i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw last;
}

/**
 * Official SDK path. `client.reply(email, …)` only reads `email.id` (verified in @primitivedotdev/sdk 2.4.0
 * dist: reply -> replyById(client, email.id, …) -> POST /emails/{id}/reply with body_text), so we pass a minimal object.
 * The same explicit Idempotency-Key is reused on every retry, with the identical body.
 */
export class PrimitiveSdkSink implements ResultSink {
  private readonly c;
  constructor(apiKey: string, opts: { fetch?: typeof fetch; apiBaseUrl?: string } = {}) {
    this.c = primitiveClient({ apiKey, ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.apiBaseUrl ? { apiBaseUrl: opts.apiBaseUrl } : {}) });
  }
  async deliver(replyEmailId: string, result: WorkResult) {
    const text = body(result);
    const key = resultIdempotencyKey(result.operation_id, result.generation);
    const r = await withRetry(
      () => this.c.reply({ id: replyEmailId } as ReceivedEmail, { text }, { idempotencyKey: key, timeout: 30_000 }),
      (e) => { const s = (e as { status?: number }).status; return !s || s === 429 || s >= 500; },
    );
    const rr = r as unknown as { id?: string; idempotentReplay?: boolean };
    return { id: rr.id ?? null, replayed: !!rr.idempotentReplay };
  }
}

/** Documented REST fallback: POST https://api.primitive.dev/v1/emails/{id}/reply with body_text. */
export class PrimitiveRestSink implements ResultSink {
  constructor(private readonly apiKey: string, private readonly opts: { fetch?: typeof fetch; baseUrl?: string } = {}) {}
  async deliver(replyEmailId: string, result: WorkResult) {
    const text = body(result);
    const f = this.opts.fetch ?? fetch;
    const url = `${(this.opts.baseUrl ?? "https://api.primitive.dev/v1").replace(/\/+$/, "")}/emails/${encodeURIComponent(replyEmailId)}/reply`;
    return withRetry(async () => {
      const res = await f(url, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", "idempotency-key": resultIdempotencyKey(result.operation_id, result.generation) },
        body: JSON.stringify({ body_text: text }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) { const err = new Error(`Primitive reply HTTP ${res.status}`) as Error & { status: number }; err.status = res.status; throw err; }
      const j = (await res.json().catch(() => ({}))) as { data?: { id?: string }; id?: string };
      return { id: j.data?.id ?? j.id ?? null, replayed: res.headers.get("idempotent-replayed") === "true" };
    }, (e) => { const s = (e as { status?: number }).status; return !s || s === 429 || s >= 500; });
  }
}

/** Local runs: write the exact reply body that would be sent. */
export class LocalSink implements ResultSink {
  readonly delivered: { replyEmailId: string; idempotencyKey: string; result: WorkResult }[] = [];
  constructor(private readonly outDir?: string) {}
  async deliver(replyEmailId: string, result: WorkResult) {
    const text = body(result);
    this.delivered.push({ replyEmailId, idempotencyKey: resultIdempotencyKey(result.operation_id, result.generation), result });
    if (this.outDir) {
      await mkdir(this.outDir, { recursive: true });
      await writeFile(join(this.outDir, "work_result.json"), JSON.stringify(JSON.parse(text), null, 2));
    }
    return { id: null, replayed: false };
  }
}

export function sinkFromEnv(): ResultSink {
  const key = process.env.PRIMITIVE_WORKER_API_KEY;
  if (!key) throw new Error("PRIMITIVE_WORKER_API_KEY is not set");
  // PRIMITIVE_API_BASE_URL is for local integration tests/staging only; production uses the SDK default.
  const base = process.env.PRIMITIVE_API_BASE_URL;
  return (process.env.PRIMITIVE_TRANSPORT ?? "sdk") === "rest"
    ? new PrimitiveRestSink(key, base ? { baseUrl: base } : {})
    : new PrimitiveSdkSink(key, base ? { apiBaseUrl: base } : {});
}
