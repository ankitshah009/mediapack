// Media access. The worker never holds storage credentials: it asks control for short-lived signed URLs scoped
// to its operation (POST /internal/operations/:id/artifact-access) and uses plain fetch against them.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as pause } from "node:timers/promises";
import { redact, WorkerError } from "./errors.js";

export interface UploadSpec { name: string; content_type: string }
export interface UploadSlot { name: string; object_key: string; content_type: string }
export interface SourceFetch { bytes: number; sha256: string | null; overLimit: boolean }

export interface MediaStore {
  /** Stream the source into `destFile`, hashing the actual bytes. Stops early (overLimit) past maxBytes. */
  fetchSource(destFile: string, maxBytes: number, signal?: AbortSignal): Promise<SourceFetch>;
  fetchIndex(signal?: AbortSignal): Promise<Buffer>;
  /** Reserve object keys for all outputs up front (so the index JSON can reference frame keys). */
  prepareUploads(items: UploadSpec[], signal?: AbortSignal): Promise<UploadSlot[]>;
  upload(slot: UploadSlot, body: Buffer, signal?: AbortSignal): Promise<void>;
}

/** Validates the artifact name we send: worker-chosen, never user-derived. */
export function assertSafeName(name: string): void {
  if (!/^[a-z0-9][a-z0-9_.-]{0,80}(\/[a-z0-9][a-z0-9_.-]{0,80})?$/.test(name) || name.includes("..")) {
    throw new Error(`unsafe artifact name: ${name}`);
  }
}

async function streamToFile(body: Readable, destFile: string, maxBytes: number, signal?: AbortSignal): Promise<SourceFetch> {
  const h = createHash("sha256");
  let bytes = 0;
  let overLimit = false;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > maxBytes) { overLimit = true; cb(new Error("over-limit")); return; }
      h.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(body, meter, createWriteStream(destFile), { signal });
  } catch (e) {
    if (!overLimit) throw e;
  }
  return { bytes, sha256: overLimit ? null : h.digest("hex"), overLimit };
}

// ── HTTP implementation against control ──

interface AccessResponse {
  uploads?: { name: string; object_key: string; url: string; method?: "PUT" | "POST"; headers?: Record<string, string> }[];
  downloads?: { source?: string | { url: string }; index?: string | { url: string } };
}

export interface HttpStoreOptions {
  controlBaseUrl: string;
  operationId: string;
  workerToken: string;
  fetchImpl?: typeof fetch;
  /** ms */
  requestTimeoutMs?: number;
  downloadTimeoutMs?: number;
}

export class HttpMediaStore implements MediaStore {
  private readonly f: typeof fetch;
  private readonly slots = new Map<string, { url: string; method: "PUT" | "POST"; headers: Record<string, string> }>();
  constructor(private readonly o: HttpStoreOptions) {
    this.f = o.fetchImpl ?? fetch;
  }

  private async access(body: { uploads?: UploadSpec[]; downloads?: ("source" | "index")[] }, signal?: AbortSignal): Promise<AccessResponse> {
    const url = `${this.o.controlBaseUrl.replace(/\/+$/, "")}/internal/operations/${encodeURIComponent(this.o.operationId)}/artifact-access`;
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      try {
        const res = await this.f(url, {
          method: "POST",
          headers: { authorization: `Bearer ${this.o.workerToken}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(this.o.requestTimeoutMs ?? 20_000)]),
        });
        if (res.status === 401 || res.status === 403) {
          throw new WorkerError("WORKER_FAILED", `artifact-access rejected the worker token (HTTP ${res.status}); lease likely superseded`, false);
        }
        if (!res.ok) { last = new Error(`artifact-access HTTP ${res.status}`); if (res.status < 500) break; continue; }
        return (await res.json()) as AccessResponse;
      } catch (e) {
        signal?.throwIfAborted();
        if (e instanceof WorkerError) throw e;
        last = e;
      }
      await pause(500 * 2 ** attempt, undefined, { signal });
    }
    throw new WorkerError("WORKER_FAILED", `artifact-access failed: ${redact(String((last as Error)?.message ?? last))}`, true);
  }

  private async download(which: "source" | "index", signal?: AbortSignal): Promise<Response> {
    const acc = await this.access({ downloads: [which] }, signal);
    const d = acc.downloads?.[which];
    const url = typeof d === "string" ? d : d?.url;
    if (!url) throw new WorkerError("WORKER_FAILED", `control returned no ${which} download URL`, true);
    const res = await this.f(url, { signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(this.o.downloadTimeoutMs ?? 180_000)]) });
    if (!res.ok || !res.body) throw new WorkerError("WORKER_FAILED", `${which} download HTTP ${res.status}`, true);
    return res;
  }

  async fetchSource(destFile: string, maxBytes: number, signal?: AbortSignal): Promise<SourceFetch> {
    const res = await this.download("source", signal);
    return streamToFile(Readable.fromWeb(res.body as never), destFile, maxBytes, signal);
  }

  async fetchIndex(signal?: AbortSignal): Promise<Buffer> {
    const res = await this.download("index", signal);
    return Buffer.from(await res.arrayBuffer());
  }

  async prepareUploads(items: UploadSpec[], signal?: AbortSignal): Promise<UploadSlot[]> {
    items.forEach((i) => assertSafeName(i.name));
    const acc = await this.access({ uploads: items }, signal);
    const byName = new Map((acc.uploads ?? []).map((u) => [u.name, u]));
    return items.map((i) => {
      const u = byName.get(i.name);
      if (!u?.url || !u.object_key) throw new WorkerError("WORKER_FAILED", `control returned no upload slot for ${i.name}`, true);
      if (u.method && u.method !== "PUT" && u.method !== "POST") throw new WorkerError("WORKER_FAILED", "control returned an unsupported upload method", false);
      this.slots.set(u.object_key, { url: u.url, method: u.method ?? "PUT", headers: u.headers ?? {} });
      return { name: i.name, object_key: u.object_key, content_type: i.content_type };
    });
  }

  async upload(slot: UploadSlot, body: Buffer, signal?: AbortSignal): Promise<void> {
    const s = this.slots.get(slot.object_key);
    if (!s) throw new Error(`no upload URL for ${slot.object_key}`);
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      try {
        const headers: Record<string, string> = { "content-type": slot.content_type, ...s.headers };
        const res = await this.f(s.url, { method: s.method, headers, body: new Uint8Array(body), signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60_000)]) });
        if (res.ok) return;
        last = new Error(`HTTP ${res.status}`);
        if (res.status < 500 && res.status !== 429) break;
      } catch (e) { signal?.throwIfAborted(); last = e; }
      await pause(500 * 2 ** attempt, undefined, { signal });
    }
    throw new WorkerError("WORKER_FAILED", `upload of ${slot.name} failed: ${redact(String((last as Error)?.message ?? last))}`, true);
  }
}

// ── Local implementation (dev CLI + tests): same keys, files on disk ──

export interface LocalStoreOptions { sourcePath: string; indexPath?: string; outDir: string; keyPrefix: string }

export class LocalStore implements MediaStore {
  readonly written: { object_key: string; path: string; bytes: number }[] = [];
  constructor(private readonly o: LocalStoreOptions) {}
  async fetchSource(destFile: string, maxBytes: number, signal?: AbortSignal): Promise<SourceFetch> {
    return streamToFile(createReadStream(this.o.sourcePath), destFile, maxBytes, signal);
  }
  async fetchIndex(signal?: AbortSignal): Promise<Buffer> {
    if (!this.o.indexPath) throw new WorkerError("INDEX_NOT_READY", "no local index path supplied (--index)", false);
    return readFile(this.o.indexPath, { signal });
  }
  async prepareUploads(items: UploadSpec[], signal?: AbortSignal): Promise<UploadSlot[]> {
    signal?.throwIfAborted();
    return items.map((i) => { assertSafeName(i.name); return { name: i.name, object_key: `${this.o.keyPrefix}/${i.name}`, content_type: i.content_type }; });
  }
  pathFor(objectKey: string): string {
    const root = resolve(this.o.outDir);
    const p = resolve(join(root, objectKey));
    if (!p.startsWith(root + sep)) throw new Error("object key escapes output dir");
    return p;
  }
  async upload(slot: UploadSlot, body: Buffer, signal?: AbortSignal): Promise<void> {
    const p = this.pathFor(slot.object_key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body, { signal });
    this.written.push({ object_key: slot.object_key, path: p, bytes: body.length });
  }
}
