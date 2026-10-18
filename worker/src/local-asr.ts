// Local, CPU-only Whisper. Engine and multilingual weights are baked into the image;
// this module never downloads a model and never falls back to a paid service.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INPUT_LIMITS } from "./contracts/index.js";
import { WorkerError } from "./errors.js";
import type { AsrModel, AsrSegment } from "./models.js";
import { run } from "./proc.js";

export const WHISPER_MODEL_SHA256 = "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe";
export const WHISPER_ENGINE_VERSION = "1.9.5";
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const fail = (message: string, retryable = false) => new WorkerError("TRANSCRIPTION_FAILED", message, retryable);

/** ffmpeg's PCM WAV can contain LIST/JUNK chunks; do not assume a 44-byte header. */
export function wavDurationSeconds(wav: Buffer): number {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") throw fail("Local transcription requires a RIFF PCM WAV; extract mono 16 kHz audio with ffmpeg.");
  let formatOK = false;
  let dataBytes = 0;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const name = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > wav.length) throw fail("Audio WAV is truncated; extract the audio again.");
    if (name === "fmt ") {
      formatOK = size >= 16 && wav.readUInt16LE(start) === 1 && wav.readUInt16LE(start + 2) === 1
        && wav.readUInt32LE(start + 4) === 16000 && wav.readUInt32LE(start + 8) === 32000
        && wav.readUInt16LE(start + 12) === 2 && wav.readUInt16LE(start + 14) === 16;
    }
    if (name === "data") dataBytes += size;
    offset = start + size + (size % 2);
  }
  if (!formatOK || !dataBytes || dataBytes % 2) throw fail("Local transcription requires non-empty mono 16 kHz, 16-bit PCM audio.");
  const seconds = dataBytes / 32000;
  if (seconds * 1000 > INPUT_LIMITS.maxDurationMs) throw fail(`Audio exceeds the ${INPUT_LIMITS.maxDurationMs / 1000}-second input limit.`);
  return seconds;
}

/** whisper-cli JSON offsets are milliseconds, unlike the AsrModel interface's seconds. */
export function parseWhisperSegments(raw: unknown, seconds: number): AsrSegment[] {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { transcription?: unknown }).transcription)) throw fail("Local Whisper returned malformed JSON; verify the pinned worker image.");
  const items = (raw as { transcription: unknown[] }).transcription;
  if (items.length > 5000) throw fail("Local Whisper returned too many transcript segments.");
  return items.map((item, id) => {
    const s = item as { text?: unknown; offsets?: { from?: unknown; to?: unknown } } | null;
    const start = s?.offsets?.from, end = s?.offsets?.to;
    if (typeof s?.text !== "string" || !Number.isInteger(start) || !Number.isInteger(end)
      || (start as number) < 0 || (end as number) < (start as number)
      || (end as number) > Math.ceil(seconds * 1000) + 1000) throw fail("Local Whisper returned invalid transcript timestamps; verify the pinned engine.");
    return { id, start: (start as number) / 1000, end: Math.min(end as number, Math.round(seconds * 1000)) / 1000, text: s.text.trim() };
  }).filter((s) => s.text && s.end > s.start);
}

export interface LocalAsrOptions {
  binary?: string;
  modelPath?: string;
  workDir?: string;
  timeoutMs?: number;
}

export class WhisperCppAsr implements AsrModel {
  constructor(private readonly options: LocalAsrOptions = {}) {}

  async transcribe(wav: Buffer, signal?: AbortSignal): Promise<{ segments: AsrSegment[]; seconds: number }> {
    signal?.throwIfAborted();
    const seconds = wavDurationSeconds(wav);
    const modelPath = this.options.modelPath ?? process.env.WHISPER_MODEL_PATH ?? "/opt/whisper/ggml-base.bin";
    const binary = this.options.binary ?? process.env.WHISPER_CPP_BIN ?? "whisper-cli";
    const timeoutMs = this.options.timeoutMs ?? 300_000;
    const timer = AbortSignal.timeout(timeoutMs);
    const bounded = AbortSignal.any([...(signal ? [signal] : []), timer]);
    let dir: string | undefined;
    try {
      const info = await stat(modelPath).catch(() => null);
      if (!info?.isFile()) throw fail("Local Whisper model is missing. Deploy the worker image containing /opt/whisper/ggml-base.bin or set WHISPER_MODEL_PATH to that pinned multilingual base model.");
      const digest = createHash("sha256");
      for await (const chunk of createReadStream(modelPath, { signal: bounded })) digest.update(chunk as Buffer);
      if (digest.digest("hex") !== WHISPER_MODEL_SHA256) throw fail("Local Whisper model checksum mismatch. Rebuild the worker image with the pinned multilingual base weights; no download or API fallback was attempted.");
      dir = await mkdtemp(join(this.options.workDir ?? tmpdir(), "whisper-"));
      const input = join(dir, "audio.wav"), output = join(dir, "transcript");
      await writeFile(input, wav, { signal: bounded });
      const result = await run(binary, [
        "--model", modelPath, "--file", input, "--threads", "2", "--processors", "1",
        "--no-gpu", "--language", "auto", "--output-json", "--output-file", output,
      ], { timeoutMs, signal: bounded, maxOutputBytes: 64 * 1024 });
      bounded.throwIfAborted();
      if (result.timedOut) throw fail("Local Whisper exceeded its transcription deadline; retry with a shorter recording.", true);
      // CLI stdout can contain the transcript. Do not include stdout/stderr in persisted errors.
      if (result.code !== 0) throw fail(`Local Whisper exited ${result.code ?? result.signal}. Verify the pinned engine/model in the worker image.`, true);
      const file = `${output}.json`;
      const size = await stat(file).catch(() => null);
      if (!size || size.size > MAX_JSON_BYTES) throw fail("Local Whisper output is missing or too large; verify the worker image.");
      let raw: unknown;
      try { raw = JSON.parse(await readFile(file, { encoding: "utf8", signal: bounded })); }
      catch { bounded.throwIfAborted(); throw fail("Local Whisper output is invalid JSON; verify the pinned engine."); }
      return { segments: parseWhisperSegments(raw, seconds), seconds };
    } catch (error) {
      if (bounded.aborted) throw fail(signal?.aborted ? "Local transcription was canceled with the operation." : "Local transcription exceeded its deadline; retry with a shorter recording.", true);
      if (error instanceof WorkerError) throw error;
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw fail("Local whisper-cli is missing. Rebuild the worker image with the pinned engine or set WHISPER_CPP_BIN.");
      throw fail("Local transcription failed. Check worker image, model permissions and temporary disk space.", true);
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
