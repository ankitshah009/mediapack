// index_video + search_video through the real OpenAI SDK with a recorded fake at the HTTP edge.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { INDEX_LIMITS, SearchResult } from "../contracts/index.js";
import { buildIndexText, SAMPLING_LIMITATION, type IndexDoc } from "../actions.js";
import { OpenAIAsr, OpenAISearch, OpenAIVision } from "../models.js";
import { spawnLog } from "../proc.js";
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
  const spawnedAt = spawnLog.length;
  const ok = await indexFixture(TALK, { transcript: { segments: transcript } });
  const spawned = spawnLog.slice(spawnedAt);
  const audioAt = spawned.findIndex((s) => s.args.includes("pcm_s16le"));
  const sampleAt = spawned.findIndex((s) => s.args.includes("image2"));
  assert.ok(audioAt >= 0 && sampleAt > audioAt, "audio extract starts before frame sampling so transcription overlaps decode");
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

test("search reviews later contradictory field text and preserves nonconsecutive transition evidence", async () => {
  const { r, calls } = await searchOver(SETTINGS, "Compare the connection limit before and after the later change", {
    search: (text, ids) => {
      assert.match(text, /f_0004 .*Connection limit 12 Saved/);
      assert.match(text, /f_0026 .*Connection limit 4/);
      assert.equal(ids.length, 27, "all chronological context reaches the model, including later generic frames");
      return { answer: "The saved connection limit was 12 (f_0004); later it is 4 (f_0026).", no_match: false, matches: [
        { record_ids: ["f_0026", "f_0004"], description: "Saved limit 12, later limit 4.", evidence_status: "supported" },
      ] };
    },
  }, { observe: id => ({ description: "Connection configuration screen.", visible_text: id === "f_0004" ? "Connection limit 12 Saved" : id === "f_0026" ? "Connection limit 4" : "Unrelated request log: duration 12" }) });
  assert.equal(r.status, "succeeded", JSON.stringify(r.error));
  const result = SearchResult.parse(r.result);
  assert.deepEqual(result.matches[0]!.frame_refs, ["f_0004", "f_0026"]);
  assert.deepEqual([result.matches[0]!.start_ms, result.matches[0]!.end_ms], [6000, 52000]);
  const body = calls[0]!.body as { instructions: string; text: { format: { schema: { required: string[]; properties: Record<string, unknown> } } } };
  assert.match(body.instructions, /ENTIRE chronological record list/);
  assert.match(body.instructions, /BOTH relevant states/);
  assert.match(body.instructions, /Do not invent a reload/);
  const schema = body.text.format.schema;
  assert.deepEqual(Object.keys(schema.properties).slice(0, 2), ["evidence_review", "answer"]);
  assert.ok(schema.required.includes("evidence_review"), "structured source observations precede the final answer");
});

test("gpt-4o-mini vision and search omit reasoning while preserving gateway auth, schemas and signals", async (t) => {
  const fake = fakeOpenAIFetch();
  const previous = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = "https://gateway.example/workspace/models/vision/v1";
  t.after(() => { if (previous === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = previous; });
  const ac = new AbortController();
  const seen: { url: string; signal?: AbortSignal | null; auth: string | null; payload: Record<string, unknown> }[] = [];
  const edge = (async (input, init) => {
    seen.push({ url: String(input), signal: init?.signal, auth: new Headers(init?.headers).get("authorization"), payload: JSON.parse(String(init?.body)) });
    assert.equal(init?.signal?.aborted, false);
    return fake.fetch(input, init);
  }) as typeof fetch;
  const options = { apiKey: "ephemeral-gateway-token", fetch: edge, maxRetries: 0, reasoningEffort: "high", visionModel: "gpt-4o-mini", searchModel: "gpt-4o-mini" };
  const vision = await new OpenAIVision(options).describe([{ frame_id: "f_0001", jpeg: Buffer.from("fixture bytes") }], ac.signal);
  const search = await new OpenAISearch(options).search({ query: "what is shown", indexText: "f_0001: observed frame", recordIds: ["f_0001"], maxResults: 1 }, ac.signal);
  assert.equal(vision.observations.length, 1);
  assert.equal(search.no_match, true);
  assert.equal(seen.length, 2);
  for (const call of seen) {
    assert.equal(call.url, "https://gateway.example/workspace/models/vision/v1/responses");
    assert.equal(call.auth, "Bearer ephemeral-gateway-token");
    assert.equal(call.payload.model, "gpt-4o-mini");
    assert.equal(Object.hasOwn(call.payload, "reasoning"), false);
    assert.equal((call.payload.text as { format: { strict: boolean } }).format.strict, true);
    assert.ok(call.signal);
  }
});

test("gpt-5 models retain configured/default reasoning effort on vision and search requests", async (t) => {
  const fake = fakeOpenAIFetch();
  const previous = process.env.OPENAI_REASONING_EFFORT;
  delete process.env.OPENAI_REASONING_EFFORT;
  t.after(() => { if (previous === undefined) delete process.env.OPENAI_REASONING_EFFORT; else process.env.OPENAI_REASONING_EFFORT = previous; });
  const options = { apiKey: "fake", fetch: fake.fetch, maxRetries: 0 };
  await new OpenAIVision({ ...options, visionModel: "gpt-5.4-mini" }).describe([{ frame_id: "f_0001", jpeg: Buffer.from("fixture bytes") }]);
  await new OpenAISearch({ ...options, searchModel: "gpt-5-mini", reasoningEffort: "high" }).search({ query: "what is shown", indexText: "f_0001: observed", recordIds: ["f_0001"], maxResults: 1 });
  assert.deepEqual((fake.calls[0].body as { reasoning: unknown }).reasoning, { effort: "low" });
  assert.deepEqual((fake.calls[1].body as { reasoning: unknown }).reasoning, { effort: "high" });
});

test("canceling a gpt-4o-mini request aborts the real SDK's in-flight HTTP request", async () => {
  const ac = new AbortController();
  const edge = ((_input, init) => new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    ac.abort(new Error("operation expired"));
  })) as typeof fetch;
  const model = new OpenAIVision({ apiKey: "fake", fetch: edge, maxRetries: 0, visionModel: "gpt-4o-mini" });
  await assert.rejects(model.describe([{ frame_id: "f_0001", jpeg: Buffer.from("fixture bytes") }], ac.signal), { code: "MODEL_UNAVAILABLE", retryable: true });
});
