import assert from "node:assert/strict";
import { test } from "node:test";
import { registerViews } from "mcp-use";
import { setTimeout as delay } from "node:timers/promises";
import { callTool, uuidFrom } from "../src/tools.js";
import { apiOptions, type ApiOptions, type ToolContext } from "../src/api.js";
import { buildServer } from "../src/build-server.js";

const job = "d6b77d18-3cf7-4b45-873d-d28296b889ca";
const video = "d8d46184-9342-4ba3-a015-968ec09d7616";
const artifact = "e789b45c-7e7b-4567-9c31-ad72bb7cf673";
const requestId = "3631827f-d6e8-47f6-ad53-8a14a03ca0a4";
const context = (token = "test-capability"): ToolContext => ({ request: { header: (name) => name === "authorization" ? `Bearer ${token}` : undefined } });
function fakeApi(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: URL; init: RequestInit; body: any }[] = [];
  const options: ApiOptions = {
    baseUrl: "https://nextjs.blaxel.invalid",
    fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      calls.push({ url, init, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
      return handler(url, init);
    }) as typeof fetch,
  };
  return { options, calls };
}

test("per-call bearer capability is forwarded only as X-MediaPack-Token, with no cache or redirects", async () => {
  const api = fakeApi(() => Response.json({ video_id: video, state: "ready" }));
  for (const token of ["one-client", "other-client"]) {
    const r = await callTool("get_video", { video_id: video }, context(token), api.options);
    assert.equal((r.structuredContent.video as any).state, "ready");
  }
  for (let i = 0; i < api.calls.length; i++) {
    const c = api.calls[i]!;
    assert.equal(c.url.pathname, `/v1/videos/${video}`);
    assert.equal(new Headers(c.init.headers).get("x-mediapack-token"), i ? "other-client" : "one-client");
    assert.equal(new Headers(c.init.headers).get("authorization"), null);
    assert.equal(c.init.cache, "no-store");
    assert.equal(c.init.redirect, "error");
    assert.ok(c.init.signal instanceof AbortSignal);
  }
  const unauthorized = await callTool("get_job", { job_id: job }, {}, api.options);
  assert.equal("isError" in unauthorized && unauthorized.isError, true);
  assert.equal((unauthorized.structuredContent.error as any).code, "UNAUTHORIZED");
  assert.equal(api.calls.length, 2, "missing auth must not call the API");
});

test("create, completion and quote use existing REST routes and preserve explicit retry IDs", async () => {
  const api = fakeApi(() => Response.json({ quote_id: "quote", job_id: job, video_id: video, state: "probing", purchase_url: "https://nextjs.blaxel.invalid/purchase", payment_mode: "test", currency: "usd", amount_minor: 50 }));
  await callTool("create_video", { file_name: "source.mp4", size_bytes: 1024, content_type: "video/mp4", request_id: requestId }, context(), api.options);
  await callTool("complete_upload", { video_id: video, request_id: requestId }, context(), api.options);
  const quote = await callTool("quote_video", { video_id: video, request_id: requestId }, context(), api.options);
  assert.deepEqual(api.calls.map((c) => c.url.pathname), ["/v1/videos", `/v1/videos/${video}/complete`, `/v1/videos/${video}/quotes`]);
  assert.ok(api.calls.every((c) => c.init.method === "POST" && c.body.request_id === requestId));
  assert.equal(api.calls[0]!.body.video_id, undefined);
  assert.match(quote.structuredContent.next_action as string, /test mode/);
  assert.match(quote.structuredContent.next_action as string, /do not pay again/);
});

test("Free-plan upload limit rejects oversized agent input before calling the API", async () => {
  const api = fakeApi(() => Response.json({ video_id: video, upload: { method: "PUT", url: "https://storage.invalid/upload" } }));
  const input = { file_name: "at-limit.mp4", size_bytes: 50 * 1024 ** 2, content_type: "video/mp4", request_id: requestId };
  const accepted = await callTool("create_video", input, context(), api.options);
  assert.equal("isError" in accepted, false);
  assert.equal(api.calls.length, 1);
  const rejected = await callTool("create_video", { ...input, size_bytes: input.size_bytes + 1 }, context(), api.options);
  assert.equal("isError" in rejected && rejected.isError, true);
  assert.equal((rejected.structuredContent.error as any).code, "BAD_REQUEST");
  assert.equal(api.calls.length, 1, "oversized inputs must not reserve storage");
});

test("pending search and media operations preserve operation fields and stable retry IDs", async () => {
  const api = fakeApi(() => Response.json({ operation_id: "pending-op", state: "running", result: null }, { status: 202, headers: { "retry-after": "7" } }));
  const first = await callTool("search_video", { job_id: job, query: "timeout changed" }, context(), api.options);
  await callTool("search_video", { job_id: job, query: "timeout changed" }, context(), api.options);
  assert.equal(api.calls[0]!.body.request_id, uuidFrom("search", job, "timeout changed", "3"));
  assert.deepEqual(api.calls[0]!.body, api.calls[1]!.body);
  assert.equal(first.structuredContent.state, "running");
  assert.equal(first.structuredContent.retry_after_seconds, 7);
  assert.match(first.structuredContent.next_action as string, /poll get_job/);
  await callTool("get_frames", { job_id: job, timestamps_ms: [2000, 1000, 2000] }, context(), api.options);
  await callTool("get_frames", { job_id: job, timestamps_ms: [1000, 2000] }, context(), api.options);
  assert.equal(api.calls[2]!.body.request_id, api.calls[3]!.body.request_id);
  await callTool("get_clip", { job_id: job, start_ms: 0, end_ms: 5000, request_id: requestId }, context(), api.options);
  assert.equal(api.calls[4]!.body.request_id, requestId);
  assert.ok(api.calls.every((c) => !c.url.pathname.includes("/access")), "pending work must never fetch artifacts");
});

test("upstream payment and allowance errors remain actionable and retain their exact structured body", async () => {
  for (const status of [402, 409]) {
    const body = { error: { code: status === 402 ? "PAYMENT_REQUIRED" : "ALLOWANCE_EXCEEDED", message: "Next step needed.", retryable: false, next_action: "Inspect get_job before doing more work." }, hint: "Upstream hint", next_action: "Upstream action", purchase_url: "https://nextjs.blaxel.invalid/purchase" };
    const api = fakeApi(() => Response.json(body, { status }));
    const r = await callTool("search_video", { job_id: job, query: "timeout changed" }, context(), api.options);
    assert.equal("isError" in r && r.isError, true);
    assert.deepEqual(r.structuredContent, body);
    assert.deepEqual(JSON.parse(r.content[0]!.text), body);
    assert.equal(api.calls.length, 1, "paid mutations must never be automatically retried");
  }
});

test("successful frames, clips and polled jobs resolve authorized artifact URLs through the API", async () => {
  const ref = { artifact_id: artifact, actual_ms: { start: 1000 }, requested_ms: { start: 1000 }, sha256: "source-sha" };
  const operation = { operation_id: "done-op", kind: "get_clip", state: "succeeded", result: { artifacts: [ref] } };
  const api = fakeApi((url) => url.pathname.endsWith("/access") ? Response.json({ url: "https://private-storage.invalid/media?signature=short-lived", expires_at: "2026-10-18T00:00:00Z" }) : url.pathname === `/v1/jobs/${job}` ? Response.json({ job_id: job, operations: [operation] }) : Response.json(operation));
  const clip = await callTool("get_clip", { job_id: job, start_ms: 1000, end_ms: 2000 }, context(), api.options);
  assert.equal((clip.structuredContent.access as any).url, "https://private-storage.invalid/media?signature=short-lived");
  const frames = await callTool("get_frames", { job_id: job, timestamps_ms: [1000] }, context(), api.options);
  assert.equal((frames.structuredContent.result as any).artifacts[0].url_expires_at, "2026-10-18T00:00:00Z");
  const polled = await callTool("get_job", { job_id: job }, context(), api.options);
  assert.equal((polled.structuredContent.operations as any)[0].result.artifacts[0].url, "https://private-storage.invalid/media?signature=short-lived");
  assert.ok(api.calls.every((c) => c.url.hostname === "nextjs.blaxel.invalid"), "the proxy must not send capabilities to storage URLs");
  assert.equal(api.calls.filter((c) => c.url.pathname === `/v1/artifacts/${artifact}/access`).length, 3);
});

test("network failures expose the retry ID without leaking network exception text", async () => {
  const api = fakeApi(() => { throw new Error("sensitive network details must not escape"); });
  const r = await callTool("create_video", { file_name: "source.mp4", size_bytes: 1024, content_type: "video/mp4" }, context(), api.options);
  assert.equal("isError" in r && r.isError, true);
  assert.match(r.content[0]!.text, new RegExp(api.calls[0]!.body.request_id));
  assert.doesNotMatch(r.content[0]!.text, /sensitive network details/);
});

test("expired jobs preserve status, payment history and operations without minting artifact URLs", async () => {
  for (const expiry of [{ state: "expired", pack_expires_at: "2099-01-01T00:00:00Z" }, { state: "ready", pack_expires_at: "2000-01-01T00:00:00Z" }]) {
    const body = { job_id: job, payment_state: "paid", payment_intent_id: "pi_persisted", ...expiry, operations: [{ operation_id: "old-delivery", state: "succeeded", result: { artifacts: [{ artifact_id: artifact }] } }] };
    const api = fakeApi((url) => url.pathname.endsWith("/access") ? Response.json({ error: { code: "PACK_EXPIRED" } }, { status: 410 }) : Response.json(body));
    const r = await callTool("get_job", { job_id: job }, context(), api.options);
    assert.equal("isError" in r, false);
    assert.deepEqual(r.structuredContent, body);
    assert.equal(api.calls.length, 1, "reading expired job history must not request fresh artifact access");
    assert.equal(api.calls[0]!.url.pathname, `/v1/jobs/${job}`);
  }
});

test("timeout cancels the HTTP boundary and instructs callers to poll before retrying", async () => {
  const api = fakeApi(async (_url, init) => {
    await delay(20);
    init.signal!.throwIfAborted();
    return Response.json({ state: "succeeded" });
  });
  const r = await callTool("search_video", { job_id: job, query: "timeout changed", request_id: requestId }, context(), { ...api.options, timeoutMs: 1 });
  assert.equal("isError" in r && r.isError, true);
  assert.equal((r.structuredContent.error as any).code, "UPSTREAM_TIMEOUT");
  assert.equal(api.calls[0]!.init.signal!.aborted, true);
  assert.match(r.content[0]!.text, /Check get_job\/get_video/);
  assert.match(r.content[0]!.text, new RegExp(requestId));
});

test("configuration requires a canonical API URL without embedded credentials", () => {
  assert.throws(() => apiOptions({}), /MEDIAPACK_API_URL/);
  assert.throws(() => apiOptions({ MEDIAPACK_API_URL: "https://token@example.com" }), /without credentials/);
  assert.throws(() => apiOptions({ MEDIAPACK_API_URL: "http://remote.example.com" }), /must use HTTPS/);
  assert.throws(() => apiOptions({ MEDIAPACK_API_URL: "http://localhost.evil.example.com" }), /must use HTTPS/);
  assert.throws(() => apiOptions({ MEDIAPACK_API_URL: "https://example.com", MEDIAPACK_API_TIMEOUT_MS: "Infinity" }), /TIMEOUT/);
  assert.equal(apiOptions({ PUBLIC_BASE_URL: "http://localhost:3000/" }).baseUrl, "http://localhost:3000");
  assert.equal(apiOptions({ MEDIAPACK_API_URL: "http://127.0.0.1:3000" }).baseUrl, "http://127.0.0.1:3000");
  assert.equal(apiOptions({ MEDIAPACK_API_URL: "http://[::1]:3000" }).baseUrl, "http://[::1]:3000");
});

test("actual MCP transport registers all nine tools and forwards request-context auth", async () => {
  const api = fakeApi(() => Response.json({ video_id: video, state: "ready" }));
  const server = buildServer(api.options);
  // The build CLI primes the production view. Supply a small resource fixture
  // here so the transport test can run independently of generated build files.
  server[registerViews]({ "search-results": { kind: "inline", js: "", css: "" } });
  try {
    const request = (method: string, params: object) => server.fetch(new Request("http://localhost:3000/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer transport-client" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }));
    const list = await request("tools/list", {});
    assert.equal(list.status, 200, await list.clone().text());
    const parse = async (res: Response) => {
      const body = await res.text();
      return res.headers.get("content-type")?.includes("text/event-stream") ? JSON.parse(body.split("\n").find((line) => line.startsWith("data: "))!.slice(6)) : JSON.parse(body);
    };
    const listed = await parse(list);
    assert.equal(listed.result.tools.length, 9);
    const response = await request("tools/call", { name: "get_video", arguments: { video_id: video } });
    assert.equal(response.status, 200, await response.clone().text());
    const called = await parse(response);
    assert.equal(called.result.structuredContent.video.state, "ready");
    assert.equal(new Headers(api.calls[0]!.init.headers).get("x-mediapack-token"), "transport-client");
  } finally { await server.close(); }
});
