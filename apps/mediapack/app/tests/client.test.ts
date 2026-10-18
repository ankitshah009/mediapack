import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Api, ApiError, api, isFixtures } from "../src/api/client.ts";
import { jobActive } from "../src/api/hooks.ts";
import type { JobView } from "../src/api/types.ts";
import { fixtureApi, VIDEOS } from "../src/dev/fixtures.ts";

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

test("ready jobs keep polling so later agent operations become visible", () => {
  assert.equal(jobActive({ state: "ready", payment_state: "paid", operations: [] } as unknown as JobView), true);
  assert.equal(jobActive({ state: "expired", payment_state: "paid", operations: [] } as unknown as JobView), false);
});

test("fixtures match the video list wire envelope and are disabled outside Vite development", async () => {
  assert.deepEqual(await fixtureApi("GET", "/v1/videos"), { videos: VIDEOS });
  const globals = { window: { location: { search: "?fixtures=1" } }, sessionStorage: {
    getItem: () => "1", setItem: () => assert.fail("Production must not persist the fixture query flag"),
  } };
  const previous = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  try {
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
    assert.equal(isFixtures(), false);
    globalThis.fetch = async () => Response.json({ videos: [] });
    assert.deepEqual(await Api.videos(), []);
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
