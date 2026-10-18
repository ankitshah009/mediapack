#!/usr/bin/env node
// Dev CLI over the exact production code path (executeManifest) with LocalStore + LocalSink.
//   node dist/local.js <action> <video> --out <dir> [--query "..."] [--max N] [--start ms --end ms] [--ts ms,ms] [--index file]
// search_video defaults --index to <out>/<video_id>/ops/<last index op>/... written by a previous index run in the same --out.
import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { SCHEMA_VERSION, WorkAction, type WorkRequest } from "./contracts/index.js";
import { sha256File } from "./media.js";
import { LocalSink } from "./sink.js";
import { LocalStore } from "./store.js";
import { executeManifest } from "./worker.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" }, query: { type: "string" }, max: { type: "string" }, start: { type: "string" }, end: { type: "string" },
    ts: { type: "string" }, index: { type: "string" }, "video-id": { type: "string" },
  },
});
const [actionArg, video] = positionals;
const action = WorkAction.safeParse(actionArg);
if (!action.success || !video || !values.out) {
  console.error("usage: node dist/local.js <probe_video|index_video|search_video|extract_frames|extract_clip> <video> --out <dir> [--query q] [--start ms --end ms] [--ts ms,ms] [--index file]");
  process.exit(2);
}
const out = resolve(values.out);
const videoId = values["video-id"] ?? "00000000-0000-4000-8000-000000000001";
const opId = randomUUID();
const input: Record<string, unknown> = {};
if (action.data === "search_video") { input.query = values.query; input.max_results = values.max ? Number(values.max) : 3; }
if (action.data === "extract_frames") input.timestamps_ms = (values.ts ?? "").split(",").filter(Boolean).map(Number);
if (action.data === "extract_clip") { input.start_ms = Number(values.start); input.end_ms = Number(values.end); }

async function latestIndex(): Promise<string | undefined> {
  const opsDir = join(out, videoId, "ops");
  const ops = await readdir(opsDir).catch(() => [] as string[]);
  let best: { p: string; m: number } | undefined;
  for (const op of ops) for (const g of await readdir(join(opsDir, op)).catch(() => [] as string[])) {
    const p = join(opsDir, op, g, "index.json");
    const s = await stat(p).catch(() => null);
    if (s && (!best || s.mtimeMs > best.m)) best = { p, m: s.mtimeMs };
  }
  return best?.p;
}

const indexPath = values.index ? resolve(values.index) : action.data === "search_video" ? await latestIndex() : undefined;
const sourceSha = action.data === "probe_video" ? null : await sha256File(video);
const req: WorkRequest = {
  schema_version: SCHEMA_VERSION, kind: "work_request", operation_id: opId, job_id: null, video_id: videoId, action: action.data,
  source_sha256: sourceSha, terms_hash: null, generation: 1, media_ref: { object_key: `${videoId}/source.mp4` }, input, reply_to_operation: opId,
};
const keyPrefix = `${videoId}/ops/${opId}/g1`;
const store = new LocalStore({ sourcePath: resolve(video), indexPath, outDir: out, keyPrefix });
const sink = new LocalSink(join(out, keyPrefix));
const t0 = Date.now();
const result = await executeManifest({ work_request: req, reply_email_id: "local", worker_token: "local", control_base_url: "http://localhost" }, { store, sink });
console.log(JSON.stringify(result, null, 2));
console.error(`\n${result.status} in ${Date.now() - t0} ms; outputs under ${join(out, keyPrefix)}`);
process.exitCode = result.status === "succeeded" ? 0 : 3;
