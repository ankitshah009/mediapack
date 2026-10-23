// Fixed action runner. Each action downloads via MediaStore, runs bounded ffmpeg/model work, uploads artifacts,
// and returns the action-specific `result` + caller `usage` + `artifacts` manifest for the WorkResult.
import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import {
  codePoints, INDEX_LIMITS, INDEXER_VERSION, INPUT_LIMITS, PACK, SearchResult, sha256Hex,
  type Usage, type WorkAction, type WorkRequest,
} from "./contracts/index.js";
import { WorkerError } from "./errors.js";
import {
  decodeCheck, extractAudio, extractClip, extractFrameAt, firstFrameAtOrAfter, judge, probe, readJpeg, sampleFrames,
  videoPacketPts,
  type ProbeInfo,
} from "./media.js";
import type { AsrModel, SearchModel, VisionModel } from "./models.js";
import type { MediaStore, UploadSlot } from "./store.js";

export interface ActionDeps {
  store: MediaStore;
  vision: () => VisionModel;
  asr: () => AsrModel;
  search: () => SearchModel;
  workDir: string;
  signal: AbortSignal;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface ActionOutput {
  result: Record<string, unknown>;
  usage?: Usage;
  artifacts: { artifact_id: string; sha256: string }[];
  provider_usage: Record<string, number>;
}

export const FRAME_LONG_EDGE = 768;
export const MAX_INDEX_TEXT_CHARS = 60_000;
export const SAMPLING_LIMITATION = "Visual evidence comes from frames sampled about every 2 s; brief events between sampled frames may be missed.";

/** Deterministic artifact UUID (v4 layout) so a transport retry reproduces the same manifest. */
export function artifactId(operationId: string, generation: number, name: string): string {
  const h = createHash("sha256").update(`${operationId}:${generation}:${name}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x40;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

const zeroUsage = (): Usage => ({ searches: 0, frames: 0, clip_ms: 0, text_chars: 0 });

/** Parallel workers. At least the old floor of 2, never more than 4, and never more than the item count. */
function workerParallelism(itemCount: number, cores = availableParallelism()): number {
  const n = Number.isFinite(cores) && cores > 0 ? Math.floor(cores) : 1;
  return Math.max(1, Math.min(itemCount, 4, Math.max(2, n)));
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]!, i); }
  }));
  return out;
}

/** Download the source, hash actual bytes, and (when the request pins a digest) refuse a different object. */
async function loadSource(req: WorkRequest, d: ActionDeps): Promise<{ path: string; bytes: number; sha256: string | null; overLimit: boolean }> {
  const path = join(d.workDir, "source.bin");
  const r = await d.store.fetchSource(path, INPUT_LIMITS.maxBytes, d.signal);
  if (req.action !== "probe_video") {
    if (r.overLimit || !r.sha256) throw new WorkerError("INPUT_LIMIT_EXCEEDED", "source exceeds the input size limit", false);
    if (req.source_sha256 && r.sha256 !== req.source_sha256) {
      throw new WorkerError("WORKER_FAILED", "downloaded source digest does not match the quoted source_sha256", false);
    }
  }
  return { path, ...r };
}

async function probeAccepted(path: string, signal?: AbortSignal): Promise<ProbeInfo & { video: NonNullable<ProbeInfo["video"]> }> {
  let info: ProbeInfo;
  try { info = await probe(path, 30_000, signal); } catch { signal?.throwIfAborted(); throw new WorkerError("MEDIA_UNSUPPORTED", "source could not be probed", false); }
  if (!info.video) throw new WorkerError("MEDIA_UNSUPPORTED", "source has no video stream", false);
  return info as ProbeInfo & { video: NonNullable<ProbeInfo["video"]> };
}

// ── probe_video ──
async function probeVideo(req: WorkRequest, d: ActionDeps): Promise<ActionOutput> {
  const src = await loadSource(req, d);
  const base = { sha256: src.sha256, size_bytes: src.bytes };
  const reject = (code: string, message: string, info?: ProbeInfo) => ({
    result: {
      accepted: false, ...base, duration_ms: info?.durationMs ?? null, width: info?.video?.width ?? null, height: info?.video?.height ?? null,
      rotation: info?.video?.rotation ?? null, audio: info ? (info.audio ? "present" : "absent") : null, reject_code: code, reject_message: message,
    },
    artifacts: [], provider_usage: { source_bytes: src.bytes },
  });
  if (src.overLimit) return reject("INPUT_LIMIT_EXCEEDED", `File exceeds ${INPUT_LIMITS.maxBytes} bytes.`);
  let info: ProbeInfo;
  try { info = await probe(src.path, 30_000, d.signal); } catch { d.signal.throwIfAborted(); return reject("MEDIA_UNSUPPORTED", "File is not a readable media container."); }
  const v = judge(info, src.bytes);
  if (!v.accepted) return reject(v.code, v.message, info);
  try { await decodeCheck(src.path, 30_000, d.signal); } catch { d.signal.throwIfAborted(); return reject("MEDIA_UNSUPPORTED", "Video stream could not be decoded.", info); }
  return {
    result: {
      accepted: true, ...base, duration_ms: info.durationMs, width: info.video!.width, height: info.video!.height,
      rotation: info.video!.rotation, audio: info.audio ? "present" : "absent",
      fps: Math.round(info.video!.fps * 1000) / 1000, video_codec: info.video!.codec, container: info.formatName,
      start_time_ms: Math.round(info.startTimeS * 1000),
    },
    artifacts: [], provider_usage: { source_bytes: src.bytes },
  };
}

// ── index_video ──
export interface IndexRecord {
  record_id: string; kind: "frame" | "speech"; start_ms: number; end_ms: number; text: string;
  visible_text?: string; frame_object_key?: string;
}
export interface IndexDoc {
  indexer_version: string; source_sha256: string; duration_ms: number; source_start_ms: number;
  visual_sample_interval_ms: number; audio: "available" | "absent" | "failed"; records: IndexRecord[];
}

const clip = (s: string, n: number) => { const t = (s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const fid = (i: number) => `f_${String(i + 1).padStart(4, "0")}`;
const sid = (i: number) => `s_${String(i + 1).padStart(4, "0")}`;

export function samplingPlan(durationMs: number): { intervalMs: number; maxFrames: number } {
  const intervalMs = Math.max(INDEX_LIMITS.sampleIntervalMs, Math.ceil(durationMs / INDEX_LIMITS.maxBaselineFrames / 100) * 100);
  return { intervalMs, maxFrames: INDEX_LIMITS.maxBaselineFrames };
}

async function indexVideo(req: WorkRequest, d: ActionDeps): Promise<ActionOutput> {
  const t0 = Date.now();
  const src = await loadSource(req, d);
  const info = await probeAccepted(src.path, d.signal);
  const pu: Record<string, number> = { source_bytes: src.bytes };
  const plan = samplingPlan(info.durationMs);
  const framesDir = join(d.workDir, "frames");
  await mkdir(framesDir, { recursive: true });
  // Audio extract and Whisper start before frame sampling finishes, so transcription
  // overlaps ffmpeg. Vision still waits for the JPEGs, then runs beside any remaining ASR.
  const wavPath = join(d.workDir, "audio.wav");
  const cancelAsr = new AbortController();
  const asrSignal = AbortSignal.any([d.signal, cancelAsr.signal]);
  const wavReady: Promise<Buffer | null> = info.audio
    ? extractAudio(src.path, wavPath, 90_000, asrSignal).then(() => readFile(wavPath))
    : Promise.resolve(null);
  let audio: IndexDoc["audio"] = info.audio ? "available" : "absent";
  let audioError: { code: "TRANSCRIPTION_FAILED"; message: string } | undefined;
  const asrP = (async () => {
    if (!info.audio) return [] as IndexRecord[];
    const ta = Date.now();
    try {
      const wav = await wavReady;
      if (!wav) return [] as IndexRecord[];
      const r = await d.asr().transcribe(wav, asrSignal);
      pu.asr_calls = 1;
      pu.asr_seconds = Math.round(r.seconds * 10) / 10;
      pu.asr_ms = Date.now() - ta;
      return r.segments
        .filter((s) => s.text.trim() && !((s.no_speech_prob ?? 0) > 0.6 && (s.avg_logprob ?? 0) < -1))
        .map((s): IndexRecord => ({
          record_id: "", kind: "speech",
          start_ms: Math.max(0, Math.min(info.durationMs, Math.round(s.start * 1000))),
          end_ms: Math.max(0, Math.min(info.durationMs, Math.round(s.end * 1000))),
          text: clip(s.text, 800),
        }))
        .filter((s) => s.end_ms >= s.start_ms);
    } catch (e) {
      audio = "failed";
      audioError = { code: "TRANSCRIPTION_FAILED", message: clip(e instanceof Error ? e.message : String(e), 300) };
      d.log?.("asr failed", { error: audioError.message });
      return [] as IndexRecord[];
    }
  })();
  let sampled;
  try {
    sampled = await sampleFrames(src.path, framesDir, { ...plan, longEdge: FRAME_LONG_EDGE, fps: info.video.fps, timeoutMs: 240_000, signal: d.signal });
  } catch (error) {
    cancelAsr.abort();
    await asrP;
    throw error;
  }
  if (sampled.length > INDEX_LIMITS.maxInternalFrames) {
    cancelAsr.abort();
    await asrP;
    throw new WorkerError("WORKER_FAILED", "sampling exceeded the internal frame cap", false);
  }
  pu.frames_sampled = sampled.length;
  pu.ffmpeg_sample_ms = Date.now() - t0;
  const frames = await Promise.all(sampled.map(async (s, i) => ({ id: fid(i), ptsMs: s.ptsMs, ...(await readJpeg(s.file)) })));

  // Vision (≤12 images/call, ≤8 calls, concurrency 2) keeps running beside ASR.
  const batches: typeof frames[] = [];
  for (let i = 0; i < frames.length; i += INDEX_LIMITS.imagesPerVisionCall) batches.push(frames.slice(i, i + INDEX_LIMITS.imagesPerVisionCall));
  if (batches.length > INDEX_LIMITS.maxVisionCalls) {
    cancelAsr.abort();
    await asrP;
    throw new WorkerError("WORKER_FAILED", "too many vision batches", false);
  }
  const vision = d.vision();
  const visionP = mapLimit(batches, INDEX_LIMITS.visionConcurrency, async (b) => {
    d.signal.throwIfAborted();
    const allowed = new Set(b.map((f) => f.id));
    const r = await vision.describe(b.map((f) => ({ frame_id: f.id, jpeg: f.buf })), d.signal);
    pu.vision_calls = (pu.vision_calls ?? 0) + 1;
    pu.vision_input_tokens = (pu.vision_input_tokens ?? 0) + r.usage.input_tokens;
    pu.vision_output_tokens = (pu.vision_output_tokens ?? 0) + r.usage.output_tokens;
    const valid = new Map<string, { description: string; visible_text: string }>();
    for (const o of r.observations) {
      if (!o || typeof o.frame_id !== "string" || !allowed.has(o.frame_id) || valid.has(o.frame_id)) { pu.vision_rejected_ids = (pu.vision_rejected_ids ?? 0) + 1; continue; }
      valid.set(o.frame_id, { description: clip(String(o.description ?? ""), 400), visible_text: clip(String(o.visible_text ?? ""), 600) });
    }
    return valid;
  });

  const [visionMaps, speech] = await Promise.all([visionP, asrP]).catch(async (error: unknown) => {
    cancelAsr.abort();
    await asrP;
    throw error;
  });
  const obs = new Map<string, { description: string; visible_text: string }>();
  for (const m of visionMaps) for (const [k, v] of m) obs.set(k, v);
  pu.vision_missing_frames = frames.length - obs.size;
  if (obs.size === 0 && frames.length > 0) throw new WorkerError("MODEL_UNAVAILABLE", "vision returned no valid frame observations", true);

  // Reserve all keys up front so the index can reference frame object keys.
  const names = frames.map((f) => ({ name: `frames/${f.id}.jpg`, content_type: "image/jpeg" }));
  const slots = await d.store.prepareUploads([...names, { name: "index.json", content_type: "application/json" }], d.signal);
  const slotByName = new Map<string, UploadSlot>(slots.map((s) => [s.name, s]));

  const records: IndexRecord[] = frames.map((f, i) => {
    const o = obs.get(f.id);
    const end = i + 1 < frames.length ? frames[i + 1]!.ptsMs : Math.min(info.durationMs, f.ptsMs + plan.intervalMs);
    return {
      record_id: f.id, kind: "frame", start_ms: f.ptsMs, end_ms: Math.max(f.ptsMs, end), text: o?.description ?? "",
      ...(o?.visible_text ? { visible_text: o.visible_text } : {}), frame_object_key: slotByName.get(`frames/${f.id}.jpg`)!.object_key,
    };
  });
  speech.sort((a, b) => a.start_ms - b.start_ms).forEach((s, i) => { s.record_id = sid(i); records.push(s); });

  const doc: IndexDoc = {
    indexer_version: INDEXER_VERSION, source_sha256: src.sha256!, duration_ms: info.durationMs,
    source_start_ms: Math.round(info.startTimeS * 1000), visual_sample_interval_ms: plan.intervalMs, audio, records,
  };
  const indexBuf = Buffer.from(JSON.stringify(doc));

  const indexSlot = slotByName.get("index.json")!;
  const [outFrames] = await Promise.all([
    mapLimit(frames, workerParallelism(frames.length), async (f) => {
      const slot = slotByName.get(`frames/${f.id}.jpg`)!;
      await d.store.upload(slot, f.buf, d.signal);
      return { record_id: f.id, object_key: slot.object_key, sha256: sha256Hex(f.buf), frame_ms: f.ptsMs, width: f.width, height: f.height, bytes: f.buf.length,
        artifact_id: artifactId(req.operation_id, req.generation, slot.name) };
    }),
    d.store.upload(indexSlot, indexBuf, d.signal),
  ]);
  const indexSha = sha256Hex(indexBuf);
  const indexArtifactId = artifactId(req.operation_id, req.generation, "index.json");

  return {
    result: {
      index_object_key: indexSlot.object_key, index_sha256: indexSha, index_artifact_id: indexArtifactId, indexer_version: INDEXER_VERSION,
      source_sha256: src.sha256, duration_ms: info.durationMs, visual_sample_interval_ms: plan.intervalMs,
      record_counts: { frame: frames.length, speech: speech.length },
      frames: outFrames, audio, ...(audioError ? { audio_error: audioError } : {}),
    },
    usage: zeroUsage(),
    artifacts: [{ artifact_id: indexArtifactId, sha256: indexSha }, ...outFrames.map((f) => ({ artifact_id: f.artifact_id, sha256: f.sha256 }))],
    provider_usage: pu,
  };
}

// ── search_video ──
const fmtS = (ms: number) => (ms / 1000).toFixed(1);

export function buildIndexText(doc: IndexDoc, maxChars = MAX_INDEX_TEXT_CHARS): { text: string; ids: string[]; omitted: number } {
  const recs = [...doc.records].sort((a, b) => a.start_ms - b.start_ms || a.record_id.localeCompare(b.record_id));
  const lines: string[] = [];
  const ids: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const r of recs) {
    const line = r.kind === "frame"
      ? `${r.record_id} [${fmtS(r.start_ms)}s-${fmtS(r.end_ms)}s] frame: ${clip(r.text, 300) || "(no description)"}${r.visible_text ? ` | on-screen text: "${clip(r.visible_text, 400)}"` : ""}`
      : `${r.record_id} [${fmtS(r.start_ms)}s-${fmtS(r.end_ms)}s] speech: "${clip(r.text, 500)}"`;
    if (used + line.length + 1 > maxChars) { omitted++; continue; }
    lines.push(line); ids.push(r.record_id); used += line.length + 1;
  }
  if (omitted) lines.push(`[note: index truncated to fit the search budget; ${omitted} records omitted]`);
  return { text: lines.join("\n"), ids, omitted };
}

async function searchVideo(req: WorkRequest, d: ActionDeps): Promise<ActionOutput> {
  const query = typeof req.input.query === "string" ? req.input.query.trim() : "";
  if (query.length < 3 || query.length > 500) throw new WorkerError("BAD_REQUEST", "query must be 3-500 characters", false);
  const maxResults = Math.min(INDEX_LIMITS.maxMatches, Math.max(1, Number.isInteger(req.input.max_results) ? Number(req.input.max_results) : INDEX_LIMITS.maxMatches));
  const raw = await d.store.fetchIndex(d.signal);
  let doc: IndexDoc;
  try { doc = JSON.parse(raw.toString("utf8")) as IndexDoc; } catch { throw new WorkerError("INDEX_NOT_READY", "index artifact is not valid JSON", false); }
  if (!Array.isArray(doc.records)) throw new WorkerError("INDEX_NOT_READY", "index artifact has no records", false);
  if (req.source_sha256 && doc.source_sha256 !== req.source_sha256) throw new WorkerError("WORKER_FAILED", "index source digest does not match the job", false);

  const { text, ids, omitted } = buildIndexText(doc);
  const pu: Record<string, number> = { index_records: doc.records.length, index_chars: text.length };
  const out = await d.search().search({ query, indexText: text, recordIds: ids, maxResults }, d.signal);
  pu.search_calls = 1;
  pu.search_input_tokens = out.usage.input_tokens;
  pu.search_output_tokens = out.usage.output_tokens;

  const byId = new Map(doc.records.map((r) => [r.record_id, r]));
  const allowed = new Set(ids);
  const durationMs = Number(doc.duration_ms) || Math.max(0, ...doc.records.map((r) => r.end_ms));
  const matches: SearchResult["matches"] = [];
  let rejected = 0;
  if (!out.no_match) {
    for (const m of out.matches) {
      if (matches.length >= maxResults) break;
      const cited = [...new Set((Array.isArray(m.record_ids) ? m.record_ids : []).filter((id) => typeof id === "string"))];
      const valid = cited.filter((id) => allowed.has(id) && byId.has(id)).map((id) => byId.get(id)!)
        .sort((a, b) => a.start_ms - b.start_ms || a.record_id.localeCompare(b.record_id));
      rejected += cited.length - valid.length;
      if (!valid.length) continue;
      const frames = valid.filter((r) => r.kind === "frame"), speech = valid.filter((r) => r.kind === "speech");
      const start = Math.max(0, Math.min(...valid.map((r) => r.start_ms)));
      const end = Math.min(durationMs || Infinity, Math.max(...valid.map((r) => r.end_ms)));
      const excerpt = speech.sort((a, b) => a.start_ms - b.start_ms).map((r) => r.text).join(" ");
      matches.push({
        match_id: `m_${matches.length + 1}`, start_ms: start, end_ms: Math.max(start, end),
        description: clip(String(m.description ?? ""), 300),
        modalities: [...(frames.length ? ["visual" as const] : []), ...(speech.length ? ["speech" as const] : [])],
        frame_refs: frames.map((r) => r.record_id), transcript_refs: speech.map((r) => r.record_id),
        ...(excerpt ? { transcript_excerpt: clip(excerpt, 500) } : {}),
        evidence_status: m.evidence_status === "supported" ? "supported" : "partial",
      });
    }
  }
  pu.search_rejected_ids = rejected;
  let answer = clip(out.answer, 800);
  if (!matches.length && (!out.no_match || !answer)) answer = "Not established from the indexed evidence.";

  const limitations = [SAMPLING_LIMITATION];
  if (doc.audio === "absent") limitations.push("The recording has no audio track; only visual samples were searched.");
  if (doc.audio === "failed") limitations.push("Transcription failed for this recording; speech was not searched.");
  if (omitted) limitations.push(`The index was truncated to fit the search budget; ${omitted} records were not considered.`);
  if (rejected) limitations.push("Some model citations did not match indexed records and were discarded.");

  const result = SearchResult.parse({
    query, answer, matches,
    coverage: { audio: doc.audio ?? "absent", visual_sample_interval_ms: Number(doc.visual_sample_interval_ms) || INDEX_LIMITS.sampleIntervalMs, limitations },
  });
  const textChars = codePoints(result.answer) + result.matches.reduce((n, m) => n + codePoints(m.description) + codePoints(m.transcript_excerpt), 0);
  return { result: result as unknown as Record<string, unknown>, usage: { ...zeroUsage(), searches: 1, text_chars: textChars }, artifacts: [], provider_usage: pu };
}

// ── extract_frames ──
async function extractFrames(req: WorkRequest, d: ActionDeps): Promise<ActionOutput> {
  const ts = req.input.timestamps_ms;
  if (!Array.isArray(ts) || ts.length < 1 || ts.length > PACK.limits.frames || !ts.every((t) => Number.isInteger(t) && t >= 0)) {
    throw new WorkerError("BAD_REQUEST", `timestamps_ms must be 1-${PACK.limits.frames} non-negative integers`, false);
  }
  const src = await loadSource(req, d);
  const info = await probeAccepted(src.path, d.signal);
  for (const t of ts as number[]) if (t > info.durationMs) throw new WorkerError("BAD_REQUEST", `timestamp ${t} ms is past the end (${info.durationMs} ms)`, false);
  const names = (ts as number[]).map((t, i) => ({ name: `frame_${String(i + 1).padStart(2, "0")}_${t}ms.jpg`, content_type: "image/jpeg" }));
  const [slots, pts] = await Promise.all([
    d.store.prepareUploads(names, d.signal),
    videoPacketPts(src.path, 30_000, d.signal),
  ]);
  const frames = await mapLimit(ts as number[], workerParallelism(ts.length), async (t, i) => {
    const file = join(d.workDir, `x_${i}.jpg`);
    // Nearest source PTS also handles a request at duration_ms by selecting the final frame.
    const { actualMs } = await extractFrameAt(src.path, t, file, info.video.fps, 30_000, d.signal, info.startTimeS, pts);
    const j = await readJpeg(file);
    if (j.width !== info.video.width || j.height !== info.video.height) {
      d.log?.("frame dims differ from probe", { got: `${j.width}x${j.height}`, probe: `${info.video.width}x${info.video.height}` });
    }
    await d.store.upload(slots[i]!, j.buf, d.signal);
    return {
      requested_ms: t, actual_ms: actualMs, object_key: slots[i]!.object_key, sha256: sha256Hex(j.buf), width: j.width, height: j.height,
      bytes: j.buf.length, content_type: "image/jpeg", artifact_id: artifactId(req.operation_id, req.generation, slots[i]!.name),
    };
  });
  return {
    result: { source_sha256: src.sha256, frames },
    usage: { ...zeroUsage(), frames: frames.length },
    artifacts: frames.map((f) => ({ artifact_id: f.artifact_id, sha256: f.sha256 })),
    provider_usage: { source_bytes: src.bytes },
  };
}

// ── extract_clip ──
async function extractClipAction(req: WorkRequest, d: ActionDeps): Promise<ActionOutput> {
  const s = req.input.start_ms, e = req.input.end_ms;
  if (!Number.isInteger(s) || !Number.isInteger(e) || (s as number) < 0 || (e as number) <= (s as number)) throw new WorkerError("BAD_REQUEST", "start_ms/end_ms must be integers with end > start", false);
  const start = s as number, end = e as number;
  if (end - start > PACK.limits.clip_ms) throw new WorkerError("BAD_REQUEST", `clip longer than ${PACK.limits.clip_ms} ms`, false);
  const src = await loadSource(req, d);
  const info = await probeAccepted(src.path, d.signal);
  if (start >= info.durationMs) throw new WorkerError("BAD_REQUEST", `start ${start} ms is past the end (${info.durationMs} ms)`, false);
  const effEnd = Math.min(end, info.durationMs);
  const frameMs = 1000 / info.video.fps;
  const out = join(d.workDir, "clip.mp4");
  const t0 = Date.now();
  const m = await extractClip(src.path, start, effEnd, out, !!info.audio, 90_000, d.signal);
  if (!m.hasVideo || m.durationMs <= 0) throw new WorkerError("WORKER_FAILED", "clip output has no measurable video stream", true);
  if (m.durationMs > effEnd - start + Math.ceil(frameMs)) throw new WorkerError("WORKER_FAILED", `clip measured ${m.durationMs} ms, longer than requested ${effEnd - start} ms + one frame`, false);
  const buf = await readFile(out);
  if ((await stat(out)).size > 200 * 1024 * 1024) throw new WorkerError("WORKER_FAILED", "clip output too large", false);
  const actualStart = await firstFrameAtOrAfter(src.path, start, info.video.fps, info.startTimeS, d.signal).catch(() => { d.signal.throwIfAborted(); return start; });
  const [slot] = await d.store.prepareUploads([{ name: "clip.mp4", content_type: "video/mp4" }], d.signal);
  await d.store.upload(slot!, buf, d.signal);
  const sha = sha256Hex(buf);
  const id = artifactId(req.operation_id, req.generation, "clip.mp4");
  return {
    result: {
      source_sha256: src.sha256,
      clip: {
        requested_start_ms: start, requested_end_ms: end, actual_start_ms: actualStart, actual_end_ms: actualStart + m.durationMs,
        duration_ms: m.durationMs, object_key: slot!.object_key, sha256: sha, width: m.width, height: m.height, bytes: buf.length,
        content_type: "video/mp4", artifact_id: id, frame_duration_ms: Math.round(frameMs * 1000) / 1000,
      },
    },
    usage: { ...zeroUsage(), clip_ms: m.durationMs },
    artifacts: [{ artifact_id: id, sha256: sha }],
    provider_usage: { source_bytes: src.bytes, ffmpeg_clip_ms: Date.now() - t0 },
  };
}

export const ACTIONS: Record<WorkAction, (req: WorkRequest, d: ActionDeps) => Promise<ActionOutput>> = {
  probe_video: probeVideo,
  index_video: indexVideo,
  search_video: searchVideo,
  extract_frames: extractFrames,
  extract_clip: extractClipAction,
};

/** Deadline per action; kept under the Blaxel process timeout chosen by the launcher (index 600 s, others 120 s). */
export const ACTION_DEADLINE_MS: Record<WorkAction, number> = {
  probe_video: 100_000, index_video: 560_000, search_video: 100_000, extract_frames: 100_000, extract_clip: 100_000,
};
