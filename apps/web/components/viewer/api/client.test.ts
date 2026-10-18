import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Api, ApiError, api } from "./client.ts";
import { preflight } from "../lib/limits.ts";
const VIDEOS = [{
  video_id: "00000000-0000-4000-8000-000000000001", file_name: "uploaded.mp4", state: "ready",
  size_bytes: 1200, sha256: "a".repeat(64), duration_ms: 10000, width: 1280, height: 720,
  audio: "present", reject: null, created_at: "2026-10-17T14:00:00Z", latest_job_id: null,
}];

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("browser preflight accepts 50 MiB and rejects one extra byte before upload", () => {
  const file = (size: number) => ({ size, type: "video/mp4" }) as File;
  assert.equal(preflight(file(50 * 1024 ** 2)), null);
  assert.match(preflight(file(50 * 1024 ** 2 + 1))!, /the limit is 50 MB/);
});

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

const JOB_ID = "00000000-0000-4000-8000-0000000000a1";

test("the viewer probe is a bodyless GET and passes the demo-agent flag through untouched", async () => {
  for (const me of [{ authenticated: true, client_id: "client-1", demo_buyer: true }, { authenticated: false }]) {
    globalThis.fetch = async (path, init) => {
      assert.equal(path, "/viewer/me");
      assert.equal(init?.method, "GET");
      assert.equal(init?.credentials, "same-origin");
      assert.equal(init?.body, undefined);
      return Response.json(me);
    };
    assert.deepEqual(await Api.me(), me);
  }
});

test("demo purchase POSTs an empty JSON body to the viewer route and resolves with the job", async () => {
  const job = { job_id: JOB_ID, payment_state: "paid", state: "paid", payment_intent_id: "pi_test_123" };
  globalThis.fetch = async (path, init) => {
    assert.equal(path, `/viewer/jobs/${JOB_ID}/demo-purchase`);
    assert.equal(init?.method, "POST");
    assert.equal(init?.credentials, "same-origin");
    assert.deepEqual(init?.headers, { "content-type": "application/json" });
    assert.deepEqual(JSON.parse(String(init?.body)), {});
    return Response.json(job);
  };
  assert.deepEqual(await Api.demoPurchase(JOB_ID), job);
});

test("demo purchase keeps the daily-limit 429 envelope's code, message and next step", async () => {
  const message = "The daily demo purchase limit is reached. Pay from your own agent (see the CLI instructions) or try again later.";
  globalThis.fetch = async () => Response.json({
    error: { code: "ALLOWANCE_EXCEEDED", message, retryable: false, retry_after_seconds: 3600, next_action: "Use the CLI buyer shown under the quote." },
    hint: message,
    next_action: "Use the CLI buyer shown under the quote.",
  }, { status: 429 });
  await assert.rejects(Api.demoPurchase(JOB_ID), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 429);
    assert.equal(e.code, "ALLOWANCE_EXCEEDED");
    assert.equal(e.message, message);
    assert.equal(e.retryable, false);
    assert.equal(e.retryAfter, 3600);
    assert.equal(e.nextAction, "Use the CLI buyer shown under the quote.");
    return true;
  });
});

test("gateway responses retain their missing-envelope flag; canonical deadline errors retain their recovery guidance", async () => {
  globalThis.fetch = async () => new Response("<html>Gateway Timeout</html>", { status: 504, headers: { "content-type": "text/html" } });
  await assert.rejects(Api.demoPurchase(JOB_ID), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 504);
    assert.equal(e.code, "INTERNAL");
    assert.equal(e.unstructured, true);
    return true;
  });
  globalThis.fetch = async () => Response.json({ error: {
    code: "INTERNAL", message: "The demo agent did not finish within 60 seconds.", retryable: false,
    next_action: "Check the job status; do not pay this quote again.",
  } }, { status: 504 });
  await assert.rejects(Api.demoPurchase(JOB_ID), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.unstructured, undefined);
    assert.equal(e.retryable, false);
    assert.equal(e.message, "The demo agent did not finish within 60 seconds.");
    assert.equal(e.nextAction, "Check the job status; do not pay this quote again.");
    return true;
  });
});

test("a durable reservation response and a lost response never trigger an automatic second payment POST", async () => {
  for (const status of [0, 409, 502]) {
    let posts = 0;
    globalThis.fetch = async (_path, init) => {
      assert.equal(init?.method, "POST");
      assert.equal(init?.credentials, "same-origin");
      assert.equal((init?.headers as Record<string, string> | undefined)?.authorization, undefined);
      posts++;
      if (status === 0) throw new TypeError("connection lost");
      return Response.json({ error: {
        code: status === 409 ? "PAYMENT_RECONCILING" : "INTERNAL", message: "A demo attempt is reserved.",
        retryable: false, next_action: "Do not pay this quote again.",
      } }, { status });
    };
    await assert.rejects(Api.demoPurchase(JOB_ID), (error: unknown) => error instanceof ApiError && error.status === status);
    assert.equal(posts, 1);
  }
});

test("demo purchase maps a disabled demo agent (404) and an expired quote (410) to their server codes", async () => {
  for (const [status, code, message] of [
    [404, "NOT_FOUND", "Demo buyer is not enabled on this deployment."],
    [410, "QUOTE_EXPIRED", "The quote expired; request a new one."],
  ] as const) {
    globalThis.fetch = async () => Response.json({ error: { code, message, retryable: false } }, { status });
    await assert.rejects(Api.demoPurchase(JOB_ID), (e: unknown) => e instanceof ApiError && e.status === status && e.code === code && e.message === message);
  }
});

test("demo purchase waits past the 30 s default, every other call still times out at 30 s", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const signals: AbortSignal[] = [];
  let answer: ((res: Response) => void) | undefined;
  globalThis.fetch = (_path, init) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      answer = resolve;
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });

  const ordinary = assert.rejects(Api.job(JOB_ID), (e: unknown) => e instanceof ApiError && e.code === "NETWORK" && e.message === "The request timed out.");
  t.mock.timers.tick(30_000);
  await ordinary;

  const slow = Api.demoPurchase(JOB_ID);
  t.mock.timers.tick(45_000);
  assert.equal(signals[1].aborted, false);
  answer!(Response.json({ job_id: JOB_ID, payment_state: "paid" }));
  assert.deepEqual(await slow, { job_id: JOB_ID, payment_state: "paid" });

  // The wait is bounded: a request the server never answers is cut at 90 s and reported as a retryable timeout.
  const stuck = assert.rejects(Api.demoPurchase(JOB_ID), (e: unknown) => e instanceof ApiError && e.code === "NETWORK" && e.retryable);
  t.mock.timers.tick(89_999);
  assert.equal(signals[2].aborted, false);
  t.mock.timers.tick(1);
  await stuck;
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
