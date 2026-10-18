import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Api, ApiError, api } from "./client.ts";
const VIDEOS = [{
  video_id: "00000000-0000-4000-8000-000000000001", file_name: "uploaded.mp4", state: "ready",
  size_bytes: 1200, sha256: "a".repeat(64), duration_ms: 10000, width: 1280, height: 720,
  audio: "present", reject: null, created_at: "2026-10-17T14:00:00Z", latest_job_id: null,
}];

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("video list unwraps the REST envelope, including an empty account", async () => {
  for (const videos of [VIDEOS, []]) {
    globalThis.fetch = async (path) => {
      assert.equal(path, "/v1/videos");
      return Response.json({ videos });
    };
    assert.deepEqual(await Api.videos(), videos);
  }
});

test("upload completion unwraps the verified/probing video from the accepted response", async () => {
  const video = { ...VIDEOS[0], state: "probing" };
  globalThis.fetch = async (path, init) => {
    assert.equal(path, `/v1/videos/${video.video_id}/complete`);
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init.body)), { request_id: "same-upload" });
    return Response.json({ video, operation_id: "probe-id", next_action: "Probing; poll get_video.", retry_after_seconds: 3 }, { status: 202 });
  };
  assert.deepEqual(await Api.completeVideo(video.video_id, "same-upload"), video);
});

test("event cursors preserve the route's raw event array", async () => {
  const events = [{ id: 12, kind: "operation.succeeded", operation_id: null, details: {}, created_at: "2026-10-17T14:00:00Z" }];
  globalThis.fetch = async (path) => {
    assert.equal(path, "/v1/jobs/job-id/events?after=11");
    return Response.json(events);
  };
  assert.deepEqual(await Api.events("job-id", 11), events);
});

test("original upload authorization uses the same access route as exported artifacts", async () => {
  const access = { url: "https://storage.example/source.mp4", expires_at: "2026-10-17T14:20:00Z", kind: "source" };
  globalThis.fetch = async (path) => {
    assert.equal(path, `/v1/artifacts/${VIDEOS[0].video_id}/access`);
    return Response.json(access);
  };
  assert.deepEqual(await Api.access(VIDEOS[0].video_id), access);
});

test("API errors retain actionable server fields", async () => {
  globalThis.fetch = async () => Response.json({ error: {
    code: "PAYMENT_RECONCILING", message: "Checking Stripe.", retryable: true,
    retry_after_seconds: 5, next_action: "Do not pay again.", job_id: "job-id",
  } }, { status: 409 });
  await assert.rejects(Api.job("job-id"), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.code, "PAYMENT_RECONCILING");
    assert.equal(e.nextAction, "Do not pay again.");
    assert.equal(e.retryAfter, 5);
    return true;
  });
});

test("a pre-aborted request stays cancelled", async () => {
  globalThis.fetch = async (_path, init) => {
    assert.equal(init?.signal?.aborted, true);
    throw new DOMException("aborted", "AbortError");
  };
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(api("GET", "/v1/videos", undefined, ctl.signal), { name: "AbortError" });
});

test("fixture query flags cannot replace real API responses", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { search: "?fixtures=1" } } });
    globalThis.fetch = async () => Response.json({ videos: [] });
    assert.deepEqual(await Api.videos(), []);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
