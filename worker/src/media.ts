// ffmpeg/ffprobe operations. All invocations use fixed binaries + argument arrays (see proc.ts); no user text is
// ever passed to these tools: only validated integers and worker-owned temp paths.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { INPUT_LIMITS } from "./contracts/index.js";
import { runOk } from "./proc.js";

/** Decoder/encoder threads. Capped so a 4 GB worker still has a core for Whisper. */
export function ffmpegThreadCount(cores = availableParallelism()): number {
  const n = Number.isFinite(cores) && cores > 0 ? Math.floor(cores) : 1;
  return Math.max(1, Math.min(4, n > 1 ? n - 1 : 1));
}

export const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
export const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";

export interface ProbeInfo {
  formatName: string;
  majorBrand: string | null;
  durationMs: number;
  /** Stream start offset (s). Worker timelines are normalized to 0 = first presented frame; add this to map back. */
  startTimeS: number;
  video: { codec: string; codedWidth: number; codedHeight: number; rotation: number; width: number; height: number; fps: number } | null;
  audio: { codec: string } | null;
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

function parseRate(r: string | undefined): number {
  if (!r) return 0;
  const [n, d] = r.split("/").map(Number);
  if (!d) return Number.isFinite(n) ? n! : 0;
  return n! / d;
}

export async function probe(path: string, timeoutMs = 30_000, signal?: AbortSignal): Promise<ProbeInfo> {
  const r = await runOk(FFPROBE, [
    "-v", "error", "-hide_banner", "-print_format", "json",
    "-show_format", "-show_streams", path,
  ], { timeoutMs, signal });
  const j = JSON.parse(r.stdout) as {
    format?: { format_name?: string; duration?: string; start_time?: string; tags?: Record<string, string> };
    streams?: Array<{
      codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string;
      duration?: string; start_time?: string; tags?: Record<string, string>; disposition?: Record<string, number>;
      side_data_list?: Array<{ side_data_type?: string; rotation?: number }>;
    }>;
  };
  const streams = j.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === "audio");
  let video: ProbeInfo["video"] = null;
  if (v && v.width && v.height) {
    let rotation = 0;
    const sd = v.side_data_list?.find((d) => typeof d.rotation === "number");
    if (sd) rotation = Number(sd.rotation);
    else if (v.tags?.rotate) rotation = Number(v.tags.rotate);
    rotation = ((Math.round(rotation) % 360) + 360) % 360;
    const swap = rotation === 90 || rotation === 270;
    video = {
      codec: v.codec_name ?? "unknown",
      codedWidth: v.width, codedHeight: v.height, rotation,
      width: swap ? v.height : v.width, height: swap ? v.width : v.height,
      fps: parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate) || 25,
    };
  }
  const durS = Number(j.format?.duration ?? v?.duration ?? NaN);
  return {
    formatName: j.format?.format_name ?? "",
    majorBrand: j.format?.tags?.major_brand?.trim() ?? null,
    durationMs: Number.isFinite(durS) ? Math.round(durS * 1000) : 0,
    startTimeS: Number(v?.start_time ?? j.format?.start_time ?? 0) || 0,
    video,
    audio: a ? { codec: a.codec_name ?? "unknown" } : null,
  };
}

export type Verdict = { accepted: true } | { accepted: false; code: "MEDIA_UNSUPPORTED" | "INPUT_LIMIT_EXCEEDED"; message: string };

/** Container + limits check against INPUT_LIMITS. Long/short edge comparison accepts portrait 1080x1920. */
export function judge(info: ProbeInfo, sizeBytes: number): Verdict {
  if (sizeBytes > INPUT_LIMITS.maxBytes) return { accepted: false, code: "INPUT_LIMIT_EXCEEDED", message: `File is ${sizeBytes} bytes; limit is ${INPUT_LIMITS.maxBytes}.` };
  const fmt = info.formatName.split(",");
  const isMp4 = fmt.includes("mp4") && info.majorBrand !== "qt";
  const isWebm = fmt.includes("webm") && !!info.video && ["vp8", "vp9", "av1"].includes(info.video.codec);
  if (!isMp4 && !isWebm) return { accepted: false, code: "MEDIA_UNSUPPORTED", message: `Container ${info.formatName || "unknown"}${info.majorBrand ? ` (${info.majorBrand})` : ""} is not MP4 or WebM.` };
  if (!info.video) return { accepted: false, code: "MEDIA_UNSUPPORTED", message: "No video stream found." };
  if (!(info.durationMs > 0)) return { accepted: false, code: "MEDIA_UNSUPPORTED", message: "Duration could not be determined." };
  if (info.durationMs > INPUT_LIMITS.maxDurationMs) return { accepted: false, code: "INPUT_LIMIT_EXCEEDED", message: `Duration ${info.durationMs} ms exceeds ${INPUT_LIMITS.maxDurationMs} ms.` };
  const long = Math.max(info.video.width, info.video.height), short = Math.min(info.video.width, info.video.height);
  if (long > INPUT_LIMITS.maxLongEdge || short > INPUT_LIMITS.maxShortEdge) {
    return { accepted: false, code: "INPUT_LIMIT_EXCEEDED", message: `Display size ${info.video.width}x${info.video.height} exceeds ${INPUT_LIMITS.maxLongEdge}x${INPUT_LIMITS.maxShortEdge} (either orientation).` };
  }
  return { accepted: true };
}

/** Prove the first video frame actually decodes. */
export async function decodeCheck(path: string, timeoutMs = 30_000, signal?: AbortSignal): Promise<void> {
  const r = await runOk(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", "-xerror", "-i", path, "-map", "0:v:0", "-frames:v", "1", "-f", "null", "-"], { timeoutMs, signal });
  if (/error/i.test(r.stderr)) throw new Error(`decode error: ${r.stderr.slice(0, 200)}`);
}

const SHOWINFO_RE = /\bn:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:(-?[0-9.]+(?:e[-+]?\d+)?)/;
export function parseShowinfo(stderr: string): { n: number; ptsTime: number }[] {
  const out: { n: number; ptsTime: number }[] = [];
  for (const line of stderr.split("\n")) {
    if (!line.includes("showinfo")) continue;
    const m = SHOWINFO_RE.exec(line);
    if (m) out.push({ n: Number(m[1]), ptsTime: Number(m[3]) });
  }
  return out;
}

/** Scale so the long edge is at most `longEdge` (never upscale), even dims. */
export const scaleLongEdge = (longEdge: number) =>
  `scale=w='if(gte(iw,ih),min(${longEdge},iw),-2)':h='if(gte(iw,ih),-2,min(${longEdge},ih))'`;

export interface SampledFrame { index: number; ptsMs: number; file: string }

/**
 * Sample one frame every `intervalMs` (first frame always), recording the decoder's actual PTS via showinfo.
 * Output JPEGs are numbered in decode order, which matches showinfo order since showinfo sits after select.
 */
export async function sampleFrames(path: string, outDir: string, o: { intervalMs: number; maxFrames: number; longEdge: number; fps: number; timeoutMs: number; signal?: AbortSignal }): Promise<SampledFrame[]> {
  const half = 0.5 / Math.max(1, o.fps);
  const step = (o.intervalMs / 1000 - half).toFixed(4);
  const vf = `select='isnan(prev_selected_t)+gte(t-prev_selected_t,${step})',showinfo,${scaleLongEdge(o.longEdge)}`;
  const r = await runOk(FFMPEG, [
    "-hide_banner", "-nostdin", "-loglevel", "info", "-threads", String(ffmpegThreadCount()), "-i", path, "-map", "0:v:0",
    "-vf", vf, "-fps_mode", "vfr", "-frames:v", String(o.maxFrames), "-q:v", "4", "-f", "image2", join(outDir, "s_%04d.jpg"),
  ], { timeoutMs: o.timeoutMs, maxOutputBytes: 16 * 1024 * 1024, signal: o.signal });
  const infos = parseShowinfo(r.stderr);
  const files = (await readdir(outDir)).filter((f) => /^s_\d{4}\.jpg$/.test(f)).sort();
  if (files.length === 0) throw new Error("frame sampling produced no frames");
  // showinfo may log one extra frame that reached the filter after -frames:v was satisfied; trust the files written.
  if (infos.length < files.length) throw new Error(`showinfo reported ${infos.length} frames but ${files.length} files were written`);
  return files.map((f, i) => ({ index: i, ptsMs: Math.round(infos[i]!.ptsTime * 1000), file: join(outDir, f) }));
}

/** One packet-timestamp scan, shared by every frame taken from the same source. */
export async function videoPacketPts(path: string, timeoutMs = 30_000, signal?: AbortSignal): Promise<number[]> {
  const packets = await runOk(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "csv=p=0", path], { timeoutMs, signal });
  const pts = packets.stdout.split("\n").map((line) => line.trim().replace(/,$/, ""))
    .filter((line) => line && line !== "N/A").map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!pts.length) throw new Error("video has no presentation timestamps");
  return pts;
}

/** Nearest decoded frame to `ms` (ties -> earlier), including variable-rate sources. */
export async function extractFrameAt(path: string, ms: number, outFile: string, _fps: number, timeoutMs = 30_000, signal?: AbortSignal, sourceStartS = 0, pts?: readonly number[]): Promise<{ actualMs: number }> {
  if (!Number.isInteger(ms) || ms < 0) throw new Error("timestamp must be a non-negative integer");
  // Packet timestamps avoid decoding the whole video and do not assume average FPS is
  // the local frame spacing. Sources are already bounded to 50 MiB / 180 seconds.
  const list = pts ?? await videoPacketPts(path, timeoutMs, signal);
  const target = sourceStartS + ms / 1000;
  const nearest = list.reduce((best, p) => Math.abs(p - target) < Math.abs(best - target) - 0.000001 ? p : best, list[0]!);
  const seek = Math.max(0, nearest - sourceStartS - 1);
  const r = await runOk(FFMPEG, [
    "-hide_banner", "-nostdin", "-loglevel", "info", "-copyts", "-ss", seek.toFixed(6), "-i", path, "-map", "0:v:0",
    "-vf", `select='gte(t,${(nearest - 0.000001).toFixed(6)})',showinfo`, "-fps_mode", "vfr", "-frames:v", "1", "-q:v", "2", "-update", "1", outFile,
  ], { timeoutMs, signal });
  const infos = parseShowinfo(r.stderr);
  if (!infos.length) throw new Error(`no frame decoded at ${ms} ms (past end of video?)`);
  const st = await stat(outFile).catch(() => null);
  if (!st || st.size === 0) throw new Error("frame extraction wrote no image");
  return { actualMs: Math.round((infos[0]!.ptsTime - sourceStartS) * 1000) };
}

/** First video packet PTS (ms, normalized to stream start) retained by an accurate input seek. */
export async function firstFrameAtOrAfter(path: string, ms: number, fps: number, startTimeS: number, signal?: AbortSignal): Promise<number> {
  const s = ms / 1000 + startTimeS;
  const r = await runOk(FFPROBE, [
    "-v", "error", "-select_streams", "v:0", "-read_intervals", `${Math.max(0, s - 2).toFixed(3)}%${(s + 2).toFixed(3)}`,
    "-show_entries", "packet=pts_time", "-of", "csv=p=0", path,
  ], { timeoutMs: 30_000, signal });
  const pts = r.stdout.split("\n").map((l) => l.trim().replace(/,$/, "")).filter((l) => l !== "" && l !== "N/A")
    .map(Number).filter((n) => Number.isFinite(n) && n >= s - 0.000001).sort((a, b) => a - b);
  if (!pts.length) throw new Error(`no video packet near ${ms} ms`);
  return Math.round((pts[0]! - startTimeS) * 1000);
}

export interface ClipOut { durationMs: number; width: number; height: number; hasVideo: boolean }

/** Accurate (re-encoded) clip, browser-playable. Measures the produced file instead of trusting the request. */
export async function extractClip(path: string, startMs: number, endMs: number, outFile: string, withAudio: boolean, timeoutMs: number, signal?: AbortSignal): Promise<ClipOut> {
  const args = [
    "-hide_banner", "-nostdin", "-v", "error", "-ss", (startMs / 1000).toFixed(3), "-i", path,
    "-t", ((endMs - startMs) / 1000).toFixed(3), "-map", "0:v:0",
    ...(withAudio ? ["-map", "0:a:0?"] : []),
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-c:v", "libx264", "-threads", String(ffmpegThreadCount()), "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
    ...(withAudio ? ["-c:a", "aac", "-b:a", "128k"] : ["-an"]),
    "-movflags", "+faststart", "-y", outFile,
  ];
  await runOk(FFMPEG, args, { timeoutMs, signal });
  return measureVideo(outFile, signal);
}

export async function measureVideo(file: string, signal?: AbortSignal): Promise<ClipOut> {
  const r = await runOk(FFPROBE, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], { timeoutMs: 30_000, signal });
  const j = JSON.parse(r.stdout) as { streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string }>; format?: { duration?: string } };
  const v = j.streams?.find((s) => s.codec_type === "video");
  const d = Number(v?.duration ?? j.format?.duration ?? NaN);
  return { durationMs: Number.isFinite(d) ? Math.round(d * 1000) : 0, width: v?.width ?? 0, height: v?.height ?? 0, hasVideo: !!v };
}

/** Mono 16 kHz 16-bit WAV for ASR (180 s ≈ 5.8 MB, under the 25 MB transcription upload limit). */
export async function extractAudio(path: string, outFile: string, timeoutMs = 60_000, signal?: AbortSignal): Promise<void> {
  await runOk(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", "-i", path, "-map", "0:a:0", "-vn", "-t", String(INPUT_LIMITS.maxDurationMs / 1000), "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y", outFile], { timeoutMs, signal });
}

/** Read JPEG dimensions from the SOF marker; throws if the buffer is not a JPEG. */
export function jpegSize(buf: Buffer): { width: number; height: number } {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error("not a JPEG");
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  throw new Error("JPEG has no SOF marker");
}

export async function readJpeg(file: string): Promise<{ buf: Buffer; width: number; height: number }> {
  const buf = await readFile(file);
  return { buf, ...jpegSize(buf) };
}
