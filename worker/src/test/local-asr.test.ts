import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { extractAudio } from "../media.js";
import { parseWhisperSegments, wavDurationSeconds, WhisperCppAsr, whisperThreadCount } from "../local-asr.js";
import { OpenAIVision } from "../models.js";
import { spawnLog } from "../proc.js";
import { executeRequest } from "../worker.js";
import { fakeOpenAIFetch, localStore, makeReq, TALK } from "./helpers.js";

test("whisper threads follow the CPU and stay inside 1..4", () => {
  assert.equal(whisperThreadCount(1), 1);
  assert.equal(whisperThreadCount(2), 2);
  assert.equal(whisperThreadCount(8), 4);
  assert.equal(whisperThreadCount(0), 1);
});

function wav(seconds: number): Buffer {
  const dataSize = Math.round(seconds * 32000);
  const b = Buffer.alloc(56 + dataSize);
  b.write("RIFF"); b.writeUInt32LE(b.length - 8, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("JUNK", 36); b.writeUInt32LE(4, 40);
  b.write("data", 48); b.writeUInt32LE(dataSize, 52);
  return b;
}

test("local ASR measures PCM payload rather than assuming a 44-byte WAV header", () => {
  assert.equal(wavDurationSeconds(wav(1.25)), 1.25);
  assert.throws(() => wavDurationSeconds(Buffer.from("not audio")), /RIFF PCM WAV/);
  assert.throws(() => wavDurationSeconds(wav(1).subarray(0, 80)), /truncated/);
  const stereo = wav(1); stereo.writeUInt16LE(2, 22);
  assert.throws(() => wavDurationSeconds(stereo), /mono 16 kHz/);
  assert.throws(() => wavDurationSeconds(wav(181)), /180-second/);
});

test("local Whisper milliseconds map exactly to the ASR seconds interface", () => {
  assert.deepEqual(parseWhisperSegments({ transcription: [{ offsets: { from: 1234, to: 5678 }, text: " transcript " }] }, 6),
    [{ id: 0, start: 1.234, end: 5.678, text: "transcript" }]);
  assert.deepEqual(parseWhisperSegments({ transcription: [] }, 6), []);
  for (const invalid of [null, {}, { transcription: [{ offsets: { from: 1000, to: 500 }, text: "invalid" }] },
    { transcription: [{ offsets: { from: -1, to: 500 }, text: "invalid" }] },
    { transcription: [{ offsets: { from: 0, to: 9000 }, text: "invalid" }] }]) {
    assert.throws(() => parseWhisperSegments(invalid, 6), /malformed|invalid transcript/);
  }
});

test("missing and modified local weights fail actionably without spawning or paid fallback", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mp-asr-errors-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const before = spawnLog.length;
  const missing = new WhisperCppAsr({ modelPath: join(dir, "missing.bin"), workDir: dir });
  await assert.rejects(missing.transcribe(wav(1)), { code: "TRANSCRIPTION_FAILED", retryable: false, message: /model is missing/ });
  const modified = join(dir, "modified.bin"); await writeFile(modified, "corrupt weights");
  await assert.rejects(new WhisperCppAsr({ modelPath: modified, workDir: dir }).transcribe(wav(1)), /checksum mismatch/);
  await assert.rejects(missing.transcribe(wav(1), AbortSignal.abort(new Error("operation expired"))), /operation expired/);
  assert.equal(spawnLog.length, before);
  assert.deepEqual((await readdir(dir)).sort(), ["modified.bin"], "failure must not leave operation scratch files");
});

const realModel = process.env.WHISPER_TEST_MODEL_PATH;
test("actual CPU Whisper indexes spoken fixture with production ASR, correct source times and temp cleanup", { skip: !realModel && "set WHISPER_TEST_MODEL_PATH to the checksum-pinned multilingual base weights", timeout: 180_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mp-asr-real-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previous = process.env.WHISPER_MODEL_PATH;
  process.env.WHISPER_MODEL_PATH = realModel!;
  t.after(() => { if (previous === undefined) delete process.env.WHISPER_MODEL_PATH; else process.env.WHISPER_MODEL_PATH = previous; });
  const fake = fakeOpenAIFetch();
  const req = await makeReq("index_video", TALK);
  const store = localStore(req, TALK, dir);
  // Only vision uses a fake HTTP edge. Production's default local ASR executes the actual installed binary.
  const result = await executeRequest(req, { store, log: () => {}, models: { vision: () => new OpenAIVision({ apiKey: "fake", fetch: fake.fetch }) } });
  assert.equal(result.status, "succeeded", JSON.stringify(result.error));
  const output = result.result as { audio: string; index_object_key: string; record_counts: { speech: number } };
  assert.equal(output.audio, "available");
  assert.ok(output.record_counts.speech > 0);
  const doc = JSON.parse(await readFile(store.pathFor(output.index_object_key), "utf8")) as { records: { kind: string; text: string; start_ms: number; end_ms: number }[] };
  const deadline = doc.records.find((r) => r.kind === "speech" && /submissions? (are )?due sunday/i.test(r.text));
  assert.ok(deadline, "real transcript must contain the fixture's spoken submission deadline");
  assert.ok(deadline.start_ms < 31000 && deadline.end_ms > 21000, JSON.stringify(deadline));
  // The video lasts 45.88 s; its actual audio track ends at 44.8606 s.
  assert.equal(result.provider_usage!.asr_seconds, 44.9);
  assert.ok(fake.calls.every((call) => !call.path.includes("transcriptions")), "audio must never reach the model HTTP edge");
  const command = spawnLog.findLast((call) => call.args.includes("--output-json"));
  assert.ok(command);
  assert.ok(command.args.includes("--no-gpu"));
  assert.equal(command.args[command.args.indexOf("--threads") + 1], String(whisperThreadCount()));
  assert.equal(command.args[command.args.indexOf("--language") + 1], "auto");
  const wavIndex = command.args.indexOf("--file");
  await assert.rejects(readFile(command.args[wavIndex + 1]), { code: "ENOENT" });
  t.diagnostic(`actual local Whisper ${result.provider_usage!.asr_seconds}s audio, ${result.provider_usage!.asr_ms}ms transcription, ${output.record_counts.speech} segments`);
});

test("actual local ASR cancels the CPU child, cleans scratch files and reports missing binary", { skip: !realModel, timeout: 10_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mp-asr-cancel-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const audio = join(dir, "fixture.wav");
  await extractAudio(TALK, audio);
  const bytes = await readFile(audio);
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 1500);
  const before = Date.now();
  await assert.rejects(new WhisperCppAsr({ modelPath: realModel!, workDir: dir }).transcribe(bytes, ac.signal), { code: "TRANSCRIPTION_FAILED", retryable: true, message: /canceled/ });
  clearTimeout(timeout);
  assert.ok(Date.now() - before < 5000, "cancellation must not wait for transcription to finish");
  assert.deepEqual(await readdir(dir), ["fixture.wav"]);
  await assert.rejects(new WhisperCppAsr({ modelPath: realModel!, binary: join(dir, "missing-binary"), workDir: dir }).transcribe(bytes), { code: "TRANSCRIPTION_FAILED", retryable: false, message: /whisper-cli is missing/ });
  assert.deepEqual(await readdir(dir), ["fixture.wav"]);
});
