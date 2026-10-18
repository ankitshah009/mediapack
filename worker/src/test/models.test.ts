// index_video + search_video through the real OpenAI SDK with a recorded fake at the HTTP edge.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { INDEX_LIMITS, SearchResult } from "../contracts/index.js";
import { buildIndexText, SAMPLING_LIMITATION, type IndexDoc } from "../actions.js";
import { OpenAIAsr, OpenAISearch, OpenAIVision } from "../models.js";
import { executeRequest, type ModelFactories } from "../worker.js";
import { fakeOpenAIFetch, localStore, makeReq, SETTINGS, TALK, talkTranscript, tmp, type FakeOpenAIOptions } from "./helpers.js";

function models(o: FakeOpenAIOptions) {
  const fake = fakeOpenAIFetch(o);
  const common = { apiKey: "sk-test-fake", fetch: fake.fetch, maxRetries: 0 };
  const m: ModelFactories = { vision: () => new OpenAIVision(common), asr: () => new OpenAIAsr(common), search: () => new OpenAISearch(common) };
  return { m, calls: fake.calls };
}

async function indexFixture(video: string, o: FakeOpenAIOptions) {
  const dir = await tmp();
  const req = await makeReq("index_video", video);
  const store = localStore(req, video, dir);
  const { m, calls } = models(o);
  const r = await executeRequest(req, { store, models: m, log: () => {} });
  return { r, req, store, calls, dir };
}

test("index_video (silent): batches <=12 images, validates IDs, audio absent, writes index + frames", async () => {
  const { r, store, calls } = await indexFixture(SETTINGS, { injectBadIds: true, latencyMs: 30 });
  assert.equal(r.status, "succeeded", JSON.stringify(r.error));
  const res = r.result as { index_object_key: string; index_sha256: string; audio: string; frames: { record_id: string; object_key: string; frame_ms: number; width: number; height: number; sha256: string }[] };
  assert.equal(res.audio, "absent");
  assert.equal(res.frames.length, 27);
  const vision = calls.filter((c) => c.path.endsWith("/responses"));
  assert.equal(vision.length, 3); // 12 + 12 + 3
  assert.ok(vision.every((c) => c.images <= INDEX_LIMITS.imagesPerVisionCall));
  assert.equal(calls.filter((c) => c.path.endsWith("/audio/transcriptions")).length, 0);
  // concurrency 2: never three vision calls in flight at once
  // Count simultaneous calls at each start. Pairwise overlap with one long call can include
  // two calls that never overlap each other, so it does not measure peak concurrency.
  for (const c of vision) assert.ok(vision.filter((o) => o.startedAt <= c.startedAt && o.endedAt! > c.startedAt).length <= 2);
  const idx = JSON.parse(await readFile(store.pathFor(res.index_object_key), "utf8")) as IndexDoc;
  assert.equal(idx.indexer_version, "video-index-v1");
  assert.equal(idx.records.length, 27);
  assert.ok(!idx.records.some((x) => x.record_id === "f_9999"), "invented id must be discarded");
  assert.equal(idx.records[0]!.record_id, "f_0001");
  assert.equal(idx.records[0]!.text, "Observed f_0001.");
  assert.equal(idx.records[0]!.frame_object_key, res.frames[0]!.object_key);
  assert.deepEqual([res.frames[0]!.width, res.frames[0]!.height], [768, 480]);
  assert.ok(r.provider_usage!.vision_input_tokens! > 0 && r.provider_usage!.runtime_ms! > 0);
  assert.equal(r.provider_usage!.vision_rejected_ids, 6); // 1 invented + 1 duplicate per call
  assert.equal(r.artifacts.length, 28);
});

test("index_video (speech): whisper segments become s_#### records; ASR failure is a distinct 'failed' state", async () => {
  const transcript = await talkTranscript();
  const ok = await indexFixture(TALK, { transcript: { segments: transcript } });
  assert.equal(ok.r.status, "succeeded", JSON.stringify(ok.r.error));
  const res = ok.r.result as { audio: string; index_object_key: string; record_counts: { speech: number } };
  assert.equal(res.audio, "available");
  assert.equal(res.record_counts.speech, transcript.length);
  const asrCall = ok.calls.find((c) => c.path.endsWith("/audio/transcriptions"));
  assert.ok(asrCall, "transcription endpoint called");
  const idx = JSON.parse(await readFile(ok.store.pathFor(res.index_object_key), "utf8")) as IndexDoc;
  const s3 = idx.records.find((x) => x.text.includes("Submissions are due Sunday"))!;
  assert.equal(s3.record_id, "s_0003"); assert.equal(s3.kind, "speech"); assert.equal(s3.start_ms, 21_268);
  assert.equal(ok.r.provider_usage!.asr_seconds, 46);

  const bad = await indexFixture(TALK, { transcript: { status: 500 } });
  assert.equal(bad.r.status, "succeeded");
  const b = bad.r.result as { audio: string; audio_error?: { code: string } };
  assert.equal(b.audio, "failed"); assert.equal(b.audio_error?.code, "TRANSCRIPTION_FAILED");
});

test("index_video: vision outage -> failed MODEL_UNAVAILABLE, retryable", async () => {
  const dir = await tmp();
  const req = await makeReq("index_video", SETTINGS);
  const down = (async () => new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503, headers: { "content-type": "application/json" } })) as typeof fetch;
  const common = { apiKey: "sk-test-fake", fetch: down, maxRetries: 0 };
  const r = await executeRequest(req, { store: localStore(req, SETTINGS, dir), models: { vision: () => new OpenAIVision(common) }, log: () => {} });
  assert.equal(r.status, "failed"); assert.equal(r.error?.code, "MODEL_UNAVAILABLE"); assert.equal(r.error?.retryable, true);
});

async function searchOver(video: string, query: string, o: FakeOpenAIOptions, indexOpts: FakeOpenAIOptions) {
  const ix = await indexFixture(video, indexOpts);
  const idxPath = ix.store.pathFor((ix.r.result as { index_object_key: string }).index_object_key);
  const req = await makeReq("search_video", video, { query, max_results: 3 });
  const { m, calls } = models(o);
  const r = await executeRequest(req, { store: localStore(req, video, await tmp(), idxPath), models: m, log: () => {} });
  return { r, calls };
}

test("search_video: one call, cited IDs resolved to times, invalid IDs dropped, SearchResult shape", async () => {
  const { r, calls } = await searchOver(SETTINGS, "when does the timeout value go back to 30 after refresh", {
    search: (text, ids) => {
      const hit = text.split("\n").filter((l) => /\[(4[5-9])\.\d+s-/.test(l)).map((l) => l.split(" ")[0]!).filter((id) => ids.includes(id));
      return { answer: "After the reload the field shows 30 again.", no_match: false, matches: [
        { record_ids: [...hit.slice(0, 2), "f_9999"], description: "Request timeout field shows 30 after reload.", evidence_status: "supported" },
        { record_ids: ["s_0042"], description: "invented", evidence_status: "supported" },
      ] };
    },
  }, { observe: (id) => ({ description: `frame ${id}`, visible_text: "Request timeout 30" }) });
  assert.equal(r.status, "succeeded", JSON.stringify(r.error));
  assert.equal(calls.length, 1);
  const s = SearchResult.parse(r.result);
  assert.equal(s.matches.length, 1);
  const m = s.matches[0]!;
  assert.ok(m.start_ms < 50_000 && m.end_ms > 45_000, `${m.start_ms}-${m.end_ms}`);
  assert.deepEqual(m.modalities, ["visual"]);
  assert.ok(m.frame_refs.every((id) => /^f_\d{4}$/.test(id)) && !m.frame_refs.includes("f_9999"));
  assert.equal(s.coverage.audio, "absent");
  assert.equal(s.coverage.visual_sample_interval_ms, 2000);
  assert.ok(s.coverage.limitations.includes(SAMPLING_LIMITATION));
  assert.equal(r.usage?.searches, 1);
  assert.ok((r.usage?.text_chars ?? 0) > 0);
  assert.ok(r.provider_usage!.search_rejected_ids! >= 2);
});

test("search_video: speech match carries transcript excerpt; explicit no-match is a valid result", async () => {
  const transcript = await talkTranscript();
  const { r } = await searchOver(TALK, "when are submissions due", {
    search: (text) => {
      const line = text.split("\n").find((l) => l.includes("Submissions are due"))!;
      return { answer: "Submissions are due Sunday at ten A M.", no_match: false, matches: [{ record_ids: [line.split(" ")[0]!], description: "Speaker states the deadline.", evidence_status: "supported" }] };
    },
  }, { transcript: { segments: transcript } });
  const s = SearchResult.parse(r.result);
  const m = s.matches[0]!;
  assert.deepEqual(m.modalities, ["speech"]);
  assert.ok(m.start_ms < 31_000 && m.end_ms > 20_900);
  assert.match(m.transcript_excerpt ?? "", /Submissions are due Sunday/);
  assert.equal(s.coverage.audio, "available");

  const none = await searchOver(TALK, "where is the cat", {}, { transcript: { segments: transcript } });
  const n = SearchResult.parse(none.r.result);
  assert.equal(none.r.status, "succeeded"); assert.deepEqual(n.matches, []);
  assert.equal(none.r.usage?.searches, 1);
});

test("buildIndexText bounds the prompt and notes truncation", () => {
  const records = Array.from({ length: 500 }, (_, i) => ({ record_id: `f_${String(i + 1).padStart(4, "0")}`, kind: "frame" as const, start_ms: i * 2000, end_ms: i * 2000 + 2000, text: "x".repeat(300) }));
  const doc: IndexDoc = { indexer_version: "video-index-v1", source_sha256: "a", duration_ms: 1e6, source_start_ms: 0, visual_sample_interval_ms: 2000, audio: "absent", records };
  const b = buildIndexText(doc, 20_000);
  assert.ok(b.text.length <= 20_200);
  assert.ok(b.omitted > 0 && b.ids.length + b.omitted === 500);
  assert.match(b.text, /index truncated/);
});
