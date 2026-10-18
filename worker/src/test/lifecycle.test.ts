import assert from "node:assert/strict";
import { test } from "node:test";
import { run, spawnLog } from "../proc.js";
import { HttpMediaStore } from "../store.js";
import { executeRequest, log } from "../worker.js";
import { makeReq, SETTINGS } from "./helpers.js";

test("an already aborted action never spawns a child; active subprocesses are killed on abort", async () => {
  const before = spawnLog.length;
  const aborted = AbortSignal.abort(new Error("operation expired"));
  assert.throws(() => run(process.execPath, ["-e", "process.exit(0)"], { timeoutMs: 5000, signal: aborted }), /operation expired/);
  assert.equal(spawnLog.length, before);
  const ac = new AbortController();
  const running = run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 10000, signal: ac.signal });
  ac.abort();
  const result = await running;
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGKILL");
  assert.ok(result.elapsedMs < 2000);
});

test("operation deadline aborts an in-flight artifact-access request and produces a retryable result", async () => {
  let cancelled = false;
  let attempts = 0;
  const fetchImpl = ((_url, init) => new Promise<Response>((_resolve, reject) => {
    attempts++;
    init!.signal!.addEventListener("abort", () => { cancelled = true; reject(init!.signal!.reason); }, { once: true });
  })) as typeof fetch;
  const req = await makeReq("probe_video", SETTINGS);
  const result = await executeRequest(req, {
    store: new HttpMediaStore({ controlBaseUrl: "https://control.example", operationId: req.operation_id, workerToken: "scoped", fetchImpl }),
    deadlineMs: 30, log: () => {},
  });
  assert.equal(result.status, "failed");
  assert.equal(result.error?.retryable, true);
  assert.match(result.error!.message, /deadline/);
  assert.equal(cancelled, true);
  assert.equal(attempts, 1, "expired operations must not retry requests");
});

test("signed upload instructions preserve the provider's POST method and headers", async () => {
  const calls: RequestInit[] = [];
  const fetchImpl = (async (_url, init) => {
    calls.push(init!);
    if (calls.length === 1) return Response.json({ uploads: [{ name: "index.json", object_key: "video/ops/op/g1/index.json", method: "POST", url: "https://storage.example/signed", headers: { "x-upsert": "false" } }] });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const store = new HttpMediaStore({ controlBaseUrl: "https://control.example", operationId: "op", workerToken: "scoped", fetchImpl });
  const [slot] = await store.prepareUploads([{ name: "index.json", content_type: "application/json" }]);
  await store.upload(slot, Buffer.from("{}"));
  assert.equal(calls[1].method, "POST");
  assert.equal((calls[1].headers as Record<string, string>)["x-upsert"], "false");
  assert.equal((calls[1].headers as Record<string, string>)["content-type"], "application/json");
});

test("structured worker logs redact credentials in nested error fields", (t) => {
  let captured = "";
  t.mock.method(process.stderr, "write", (text: string) => { captured += text; return true; });
  log("download failed", { error: { message: "https://storage.example/source?token=private Bearer scoped-worker-token" } });
  assert.doesNotMatch(captured, /token=private|scoped-worker-token/);
  assert.equal(JSON.parse(captured).msg, "download failed");
});
