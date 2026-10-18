#!/usr/bin/env node
// Production entry: `node dist/run.js [manifest.json]` or env MEDIAPACK_MANIFEST=<base64 JSON>.
// Exit codes: 0 = a WorkResult (succeeded OR failed) was delivered; 1 = delivery failed; 2 = unusable manifest.
import { readFile } from "node:fs/promises";
import { sinkFromEnv } from "./sink.js";
import { HttpMediaStore } from "./store.js";
import { executeManifest, failedResult, log, salvageIds, WorkerManifest } from "./worker.js";

async function loadRaw(): Promise<unknown> {
  const arg = process.argv[2];
  const text = arg ? await readFile(arg, "utf8") : process.env.MEDIAPACK_MANIFEST ? Buffer.from(process.env.MEDIAPACK_MANIFEST, "base64").toString("utf8") : null;
  if (!text) throw new Error("no manifest: pass a file path or set MEDIAPACK_MANIFEST (base64 JSON)");
  return JSON.parse(text);
}

async function main(): Promise<number> {
  let raw: unknown;
  try { raw = await loadRaw(); } catch (e) { log("manifest unreadable", { error: String((e as Error).message) }); return 2; }
  const parsed = WorkerManifest.safeParse(raw);
  if (!parsed.success) {
    const ids = salvageIds(raw);
    log("manifest invalid", { issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`) });
    if (!ids) return 2;
    try {
      await sinkFromEnv().deliver(ids.reply_email_id, failedResult(ids.operation_id, ids.generation, "WORKER_FAILED", "worker manifest failed validation", false));
      return 0;
    } catch (e) { log("failed-result delivery failed", { error: String((e as Error).message) }); return 1; }
  }
  const m = parsed.data;
  const store = new HttpMediaStore({ controlBaseUrl: m.control_base_url, operationId: m.work_request.operation_id, workerToken: m.worker_token });
  try {
    await executeManifest(m, { store, sink: sinkFromEnv() });
    return 0;
  } catch (e) {
    log("result delivery failed", { op: m.work_request.operation_id, error: String((e as Error).message) });
    return 1;
  }
}

process.exitCode = await main();
