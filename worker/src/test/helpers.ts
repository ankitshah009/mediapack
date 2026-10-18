import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_VERSION, type WorkAction, type WorkRequest } from "../contracts/index.js";
import { sha256File } from "../media.js";
import { LocalStore } from "../store.js";

export const FIXTURES = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
export const SETTINGS = join(FIXTURES, "settings-reset.mp4");
export const TALK = join(FIXTURES, "talk-sample.mp4");
export const VIDEO_ID = "11111111-1111-4111-8111-111111111111";

export async function tmp(prefix = "mpw-"): Promise<string> { return mkdtemp(join(tmpdir(), prefix)); }

export async function makeReq(action: WorkAction, video: string, input: Record<string, unknown> = {}, pin = true): Promise<WorkRequest> {
  const op = randomUUID();
  return {
    schema_version: SCHEMA_VERSION, kind: "work_request", operation_id: op, job_id: null, video_id: VIDEO_ID, action,
    source_sha256: pin && action !== "probe_video" ? await sha256File(video) : null, terms_hash: null, generation: 1,
    media_ref: { object_key: `${VIDEO_ID}/source.mp4` }, input, reply_to_operation: op,
  };
}

export function localStore(req: WorkRequest, video: string, outDir: string, indexPath?: string): LocalStore {
  return new LocalStore({ sourcePath: video, indexPath, outDir, keyPrefix: `${req.video_id}/ops/${req.operation_id}/g${req.generation}` });
}

// ── Recorded fake for the OpenAI HTTP edge. The real `openai` SDK is used; only `fetch` is replaced. ──

export interface FakeCall { path: string; body: unknown; images: number; startedAt: number; endedAt?: number }
export interface FakeOpenAIOptions {
  /** Vision: per frame_id description/visible_text. Default echoes the id. */
  observe?: (frameId: string) => { description: string; visible_text: string };
  /** Extra junk entries to return from vision (invalid ids) to exercise validation. */
  injectBadIds?: boolean;
  /** Search: given index text + allowed ids, choose the model's output. */
  search?: (indexText: string, ids: string[]) => { answer: string; no_match: boolean; matches: { record_ids: string[]; description: string; evidence_status: string }[] };
  /** Transcription: segments (seconds) or an HTTP status to fail with. */
  transcript?: { segments: { start: number; end: number; text: string }[] } | { status: number };
  latencyMs?: number;
}

function responseJson(text: string, usage = { input_tokens: 1000, output_tokens: 100 }) {
  return {
    id: `resp_${randomUUID()}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model: "fake",
    output: [{ type: "message", id: `msg_${randomUUID()}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
    usage: { ...usage, total_tokens: usage.input_tokens + usage.output_tokens, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    error: null, incomplete_details: null,
  };
}

export function fakeOpenAIFetch(o: FakeOpenAIOptions = {}): { fetch: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const call: FakeCall = { path: url.pathname, body: null, images: 0, startedAt: Date.now() };
    calls.push(call);
    if (o.latencyMs) await new Promise((r) => setTimeout(r, o.latencyMs));
    const done = (status: number, body: unknown) => { call.endedAt = Date.now(); return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); };
    if (url.pathname.endsWith("/responses")) {
      const body = JSON.parse(String(init?.body)) as {
        text: { format: { name: string; schema: { properties: Record<string, { items?: { properties?: Record<string, { enum?: string[]; items?: { enum?: string[] } }> } }> } } };
        input: { content: { type: string; text?: string }[] }[];
      };
      call.body = body;
      const content = body.input[0]!.content;
      call.images = content.filter((c) => c.type === "input_image").length;
      if (body.text.format.name === "frame_observations") {
        const ids = body.text.format.schema.properties.frames!.items!.properties!.frame_id!.enum!;
        const frames = ids.map((id) => ({ frame_id: id, ...(o.observe?.(id) ?? { description: `Observed ${id}.`, visible_text: "" }) }));
        if (o.injectBadIds) frames.push({ frame_id: "f_9999", description: "invented", visible_text: "" }, { ...frames[0]! });
        return done(200, responseJson(JSON.stringify({ frames })));
      }
      if (body.text.format.name === "video_search") {
        const ids = body.text.format.schema.properties.matches!.items!.properties!.record_ids!.items!.enum!;
        const text = content.map((c) => c.text ?? "").join("\n");
        const out = o.search?.(text, ids) ?? { answer: "Not established.", no_match: true, matches: [] };
        return done(200, responseJson(JSON.stringify(out)));
      }
      return done(400, { error: { message: "unexpected format" } });
    }
    if (url.pathname.endsWith("/audio/transcriptions")) {
      call.body = "multipart";
      const t = o.transcript ?? { segments: [] };
      if ("status" in t) return done(t.status, { error: { message: "fake transcription failure", type: "server_error" } });
      const segments = t.segments.map((s, i) => ({ id: i, seek: 0, start: s.start, end: s.end, text: ` ${s.text}`, tokens: [], temperature: 0, avg_logprob: -0.2, compression_ratio: 1.2, no_speech_prob: 0.01 }));
      return done(200, { task: "transcribe", language: "english", duration: 45.9, text: segments.map((s) => s.text).join(""), segments, usage: { type: "duration", seconds: 46 } });
    }
    return done(404, { error: { message: `unexpected path ${url.pathname}` } });
  }) as typeof fetch;
  return { fetch: f, calls };
}

export async function talkTranscript(): Promise<{ start: number; end: number; text: string }[]> {
  const tl = JSON.parse(await readFile(join(FIXTURES, "talk-sample.timeline.json"), "utf8")) as { slides: { speech_start_ms: number; speech_end_ms: number; text: string }[] };
  return tl.slides.map((s) => ({ start: s.speech_start_ms / 1000, end: s.speech_end_ms / 1000, text: s.text }));
}
