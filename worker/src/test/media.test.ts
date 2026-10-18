// Real ffmpeg/ffprobe against the ground-truth fixtures. No mocks.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { INDEX_LIMITS } from "../contracts/index.js";
import { samplingPlan } from "../actions.js";
import { FFMPEG, FFPROBE, jpegSize, measureVideo, sampleFrames } from "../media.js";
import { run, runOk, spawnLog } from "../proc.js";
import { executeRequest } from "../worker.js";
import { localStore, makeReq, SETTINGS, TALK, tmp } from "./helpers.js";

const FRAME_MS = 40; // both fixtures are 25 fps

test("probe_video: settings-reset is 53.1 s, 1280x800, silent, accepted", async () => {
  const req = await makeReq("probe_video", SETTINGS);
  const r = await executeRequest(req, { store: localStore(req, SETTINGS, await tmp()), log: () => {} });
  assert.equal(r.status, "succeeded");
  const p = r.result as Record<string, unknown>;
  assert.equal(p.accepted, true);
  assert.ok(Math.abs((p.duration_ms as number) - 53_100) <= 50, `duration ${p.duration_ms}`);
  assert.equal(p.width, 1280); assert.equal(p.height, 800); assert.equal(p.rotation, 0);
  assert.equal(p.audio, "absent");
  assert.equal(p.size_bytes, (await readFile(SETTINGS)).length);
  assert.match(p.sha256 as string, /^[0-9a-f]{64}$/);
});

test("probe_video: talk-sample has audio", async () => {
  const req = await makeReq("probe_video", TALK);
  const r = await executeRequest(req, { store: localStore(req, TALK, await tmp()), log: () => {} });
  const p = r.result as Record<string, unknown>;
  assert.equal(p.accepted, true); assert.equal(p.audio, "present"); assert.equal(p.width, 1280); assert.equal(p.height, 720);
});

test("probe_video: non-video bytes are rejected, not crashed", async () => {
  const dir = await tmp();
  const bogus = join(dir, "x.mp4");
  await import("node:fs/promises").then((fs) => fs.writeFile(bogus, "not a video at all"));
  const req = await makeReq("probe_video", bogus);
  const r = await executeRequest(req, { store: localStore(req, bogus, dir), log: () => {} });
  assert.equal(r.status, "succeeded");
  assert.equal((r.result as Record<string, unknown>).accepted, false);
  assert.equal((r.result as Record<string, unknown>).reject_code, "MEDIA_UNSUPPORTED");
});

test("probe_video: rotated portrait reports display dims (1080x1920 accepted)", async () => {
  const dir = await tmp();
  const f = join(dir, "rot.mp4");
  // 1920x1080 coded, display-rotated 90° => 1080x1920 portrait.
  const coded = join(dir, "coded.mp4");
  await runOk(FFMPEG, ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=10:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", coded], { timeoutMs: 60_000 });
  // Rotation is input metadata; remuxing it writes the display matrix retained by MP4.
  await runOk(FFMPEG, ["-v", "error", "-display_rotation:v:0", "90", "-i", coded, "-c", "copy", "-y", f], { timeoutMs: 60_000 });
  const req = await makeReq("probe_video", f);
  const r = await executeRequest(req, { store: localStore(req, f, dir), log: () => {} });
  const p = r.result as Record<string, unknown>;
  assert.equal(p.accepted, true, JSON.stringify(p));
  assert.equal(p.width, 1080); assert.equal(p.height, 1920);
  assert.ok(p.rotation === 90 || p.rotation === 270);
});

test("sampling: every 2 s, actual PTS preserved, capped", async () => {
  const dir = await tmp();
  const plan = samplingPlan(53_120);
  assert.deepEqual(plan, { intervalMs: 2000, maxFrames: 90 });
  assert.deepEqual(samplingPlan(180_000), { intervalMs: 2000, maxFrames: 90 });
  assert.ok(samplingPlan(180_000).maxFrames <= INDEX_LIMITS.maxBaselineFrames);
  const frames = await sampleFrames(SETTINGS, dir, { ...plan, longEdge: 768, fps: 25, timeoutMs: 120_000 });
  assert.equal(frames.length, 27); // 0,2,...,52 s
  frames.forEach((f, i) => assert.ok(Math.abs(f.ptsMs - i * 2000) <= FRAME_MS, `frame ${i} pts ${f.ptsMs}`));
  const j = jpegSize(await readFile(frames[0]!.file));
  assert.deepEqual(j, { width: 768, height: 480 });
  const capped = await sampleFrames(SETTINGS, await tmp(), { intervalMs: 2000, maxFrames: 5, longEdge: 768, fps: 25, timeoutMs: 120_000 });
  assert.equal(capped.length, 5);
});

test("extract_frames: actual_ms within one frame, full-res JPEGs decode", async () => {
  const dir = await tmp();
  const ts = [0, 12_345, 45_139, 47_592, 53_100];
  const req = await makeReq("extract_frames", SETTINGS, { timestamps_ms: ts });
  const store = localStore(req, SETTINGS, dir);
  const r = await executeRequest(req, { store, log: () => {} });
  assert.equal(r.status, "succeeded", JSON.stringify(r.error));
  const frames = (r.result as { frames: { requested_ms: number; actual_ms: number; width: number; height: number; object_key: string; sha256: string }[] }).frames;
  assert.equal(frames.length, ts.length);
  assert.equal(r.usage?.frames, ts.length);
  for (const f of frames) {
    assert.ok(Math.abs(f.actual_ms - Math.min(f.requested_ms, 53_080)) <= FRAME_MS, `req ${f.requested_ms} actual ${f.actual_ms}`);
    assert.equal(f.width, 1280); assert.equal(f.height, 800);
    const path = store.pathFor(f.object_key);
    const d = await run(FFMPEG, ["-v", "error", "-i", path, "-f", "null", "-"], { timeoutMs: 20_000 });
    assert.equal(d.code, 0); assert.equal(d.stderr.trim(), "");
  }
  assert.ok(f0(frames).object_key.startsWith(`${req.video_id}/ops/${req.operation_id}/g1/`));
  assert.equal(r.artifacts.length, ts.length);
  function f0<T>(a: T[]) { return a[0]!; }
});

test("extract_frames: timestamp past the end is a non-retryable BAD_REQUEST", async () => {
  const req = await makeReq("extract_frames", SETTINGS, { timestamps_ms: [60_000] });
  const r = await executeRequest(req, { store: localStore(req, SETTINGS, await tmp()), log: () => {} });
  assert.equal(r.status, "failed"); assert.equal(r.error?.code, "BAD_REQUEST"); assert.equal(r.error?.retryable, false);
});

test("extract_frames: VFR nearest-frame selection uses source PTS rather than average FPS", async () => {
  const dir = await tmp();
  const video = join(dir, "variable.mp4");
  await runOk(FFMPEG, ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=1", "-vf", "select='eq(n,0)+eq(n,1)+eq(n,9)'", "-fps_mode", "vfr", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", video], { timeoutMs: 30000 });
  const req = await makeReq("extract_frames", video, { timestamps_ms: [450, 500, 1000] });
  const r = await executeRequest(req, { store: localStore(req, video, dir), log: () => {} });
  assert.equal(r.status, "succeeded", JSON.stringify(r.error));
  const frames = (r.result as { frames: { actual_ms: number }[] }).frames;
  assert.deepEqual(frames.map((f) => f.actual_ms), [100, 100, 900], "ties choose the earlier frame, and duration selects the final frame");
});

test("extract_frames: a non-zero source timestamp is normalized back to the video timeline", async () => {
  const dir = await tmp();
  const video = join(dir, "offset.mp4");
  await runOk(FFMPEG, ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-output_ts_offset", "5", "-y", video], { timeoutMs: 30000 });
  const req = await makeReq("extract_frames", video, { timestamps_ms: [0, 450, 1000] });
  const r = await executeRequest(req, { store: localStore(req, video, dir), log: () => {} });
  assert.equal(r.status, "succeeded", JSON.stringify(r.error));
  const frames = (r.result as { frames: { actual_ms: number }[] }).frames;
  assert.deepEqual(frames.map((f) => f.actual_ms), [0, 400, 900]);
});

test("extract_clip: 40000-52000 measures 12000 ms within one frame and plays", async () => {
  const dir = await tmp();
  const req = await makeReq("extract_clip", SETTINGS, { start_ms: 40_000, end_ms: 52_000 });
  const store = localStore(req, SETTINGS, dir);
  const r = await executeRequest(req, { store, log: () => {} });
  assert.equal(r.status, "succeeded", JSON.stringify(r.error));
  const c = (r.result as { clip: Record<string, number | string> }).clip;
  assert.ok(Math.abs((c.duration_ms as number) - 12_000) <= FRAME_MS, `duration ${c.duration_ms}`);
  assert.ok(Math.abs((c.actual_start_ms as number) - 40_000) <= FRAME_MS);
  assert.equal(c.actual_end_ms, (c.actual_start_ms as number) + (c.duration_ms as number));
  assert.equal(r.usage?.clip_ms, c.duration_ms);
  const path = store.pathFor(c.object_key as string);
  const m = await measureVideo(path);
  assert.equal(m.hasVideo, true); assert.equal(m.width, 1280); assert.equal(m.height, 800);
  const probe = await runOk(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_name,pix_fmt", "-of", "csv=p=0", path], { timeoutMs: 20_000 });
  assert.match(probe.stdout, /h264,yuv420p/);
  const decode = await run(FFMPEG, ["-v", "error", "-i", path, "-f", "null", "-"], { timeoutMs: 60_000 });
  assert.equal(decode.code, 0); assert.equal(decode.stderr.trim(), "");
  // +faststart: moov before mdat
  const head = (await readFile(path)).subarray(0, 4096).toString("latin1");
  assert.ok(head.indexOf("moov") > -1 && (head.indexOf("mdat") === -1 || head.indexOf("moov") < head.indexOf("mdat")));
});

test("extract_clip: audio is kept when present", async () => {
  const dir = await tmp();
  const req = await makeReq("extract_clip", TALK, { start_ms: 20_000, end_ms: 26_000 });
  const store = localStore(req, TALK, dir);
  const r = await executeRequest(req, { store, log: () => {} });
  assert.equal(r.status, "succeeded");
  const c = (r.result as { clip: { object_key: string; duration_ms: number } }).clip;
  assert.ok(Math.abs(c.duration_ms - 6000) <= FRAME_MS);
  const p = await runOk(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "csv=p=0", store.pathFor(c.object_key)], { timeoutMs: 20_000 });
  assert.match(p.stdout, /aac,audio/);
});

test("extract_clip: non-frame-aligned request reports the first retained source PTS", async () => {
  const req = await makeReq("extract_clip", SETTINGS, { start_ms: 12_339, end_ms: 13_539 });
  const r = await executeRequest(req, { store: localStore(req, SETTINGS, await tmp()), log: () => {} });
  assert.equal(r.status, "succeeded", JSON.stringify(r.error));
  const c = (r.result as { clip: { actual_start_ms: number } }).clip;
  assert.equal(c.actual_start_ms, 12_360, "accurate seeking discards the earlier 12,320 ms frame");
});

test("extract_clip: over-allowance and source digest mismatch are refused", async () => {
  const long = await makeReq("extract_clip", SETTINGS, { start_ms: 0, end_ms: 16_000 });
  const r1 = await executeRequest(long, { store: localStore(long, SETTINGS, await tmp()), log: () => {} });
  assert.equal(r1.error?.code, "BAD_REQUEST");
  const wrong = { ...(await makeReq("extract_clip", SETTINGS, { start_ms: 0, end_ms: 1000 })), source_sha256: "0".repeat(64) };
  const r2 = await executeRequest(wrong, { store: localStore(wrong, SETTINGS, await tmp()), log: () => {} });
  assert.equal(r2.status, "failed"); assert.equal(r2.error?.code, "WORKER_FAILED"); assert.equal(r2.error?.retryable, false);
});

test("commands never use a shell; hostile text stays a literal argument", async () => {
  assert.ok(spawnLog.length > 0, "media tests above should have spawned processes");
  for (const s of spawnLog) {
    assert.equal(s.shell, false);
    assert.ok([FFMPEG, FFPROBE].includes(s.cmd), `unexpected binary ${s.cmd}`);
    assert.ok(s.args.every((a) => typeof a === "string"));
  }
  const hostile = "x'; touch /tmp/mp-pwned; echo '$(id)`";
  const r = await run("/bin/echo", [hostile], { timeoutMs: 5000 });
  assert.equal(r.stdout.trim(), hostile);
  assert.throws(() => run("echo hi; id", [], { timeoutMs: 1000 }));
  // Static guard: no shell-based child_process APIs anywhere in the worker source.
  const { readdir } = await import("node:fs/promises");
  const srcDir = new URL("../", import.meta.url);
  for (const f of await readdir(srcDir)) {
    if (!f.endsWith(".js")) continue;
    const code = await readFile(new URL(f, srcDir), "utf8");
    // RegExp.exec is unrelated to child_process.exec; guard only bare shell APIs.
    assert.doesNotMatch(code, /shell:\s*true|\bexecSync\(|(?<!\.)\bexec\(|spawnSync\(/, f);
  }
});
