// Integration: the real built entry point (`node dist/run.js`) against a local HTTP server that plays control
// (artifact-access), signed-URL storage, and the Primitive reply API. Exercises the HttpMediaStore + Primitive SDK path.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createReadStream, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { WorkResult, sha256Hex } from "../contracts/index.js";
import { PrimitiveRestSink, PrimitiveSdkSink, resultIdempotencyKey } from "../sink.js";
import { makeReq, SETTINGS } from "./helpers.js";

const TOKEN = "wt_test_token_value";
interface Reply { path: string; idem: string | undefined; auth: string | undefined; body: { body_text: string } }
const puts = new Map<string, { headers: IncomingMessage["headers"]; body: Buffer }>();
const replies: Reply[] = [];
const accessCalls: { auth: string | undefined; body: unknown }[] = [];
let server: Server;
let base = "";

const readBody = (req: IncomingMessage) => new Promise<Buffer>((res) => { const c: Buffer[] = []; req.on("data", (d) => c.push(d)); req.on("end", () => res(Buffer.concat(c))); });

before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, base);
    const body = await readBody(req);
    const m = /^\/internal\/operations\/([0-9a-f-]+)\/artifact-access$/.exec(url.pathname);
    if (req.method === "POST" && m) {
      const auth = req.headers.authorization;
      const b = JSON.parse(body.toString()) as { uploads?: { name: string }[]; downloads?: string[] };
      accessCalls.push({ auth, body: b });
      if (auth !== `Bearer ${TOKEN}`) { res.writeHead(401).end(); return; }
      const prefix = `vid/ops/${m[1]}/g1`;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        uploads: (b.uploads ?? []).map((u) => ({ name: u.name, object_key: `${prefix}/${u.name}`, url: `${base}/storage/put/${prefix}/${u.name}?token=signed`, headers: { "x-upsert": "false" } })),
        downloads: Object.fromEntries((b.downloads ?? []).map((d) => [d, `${base}/storage/get/${d}?token=signed`])),
      }));
      return;
    }
    if (req.method === "PUT" && url.pathname.startsWith("/storage/put/")) {
      puts.set(url.pathname.slice("/storage/put/".length), { headers: req.headers, body });
      res.writeHead(200).end("{}");
      return;
    }
    if (req.method === "GET" && url.pathname === "/storage/get/source") {
      res.writeHead(200, { "content-type": "video/mp4" });
      createReadStream(SETTINGS).pipe(res);
      return;
    }
    const r = /^\/v1\/emails\/([^/]+)\/reply$/.exec(url.pathname);
    if (req.method === "POST" && r) {
      replies.push({ path: url.pathname, idem: req.headers["idempotency-key"] as string | undefined, auth: req.headers.authorization, body: JSON.parse(body.toString()) });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { id: "sent_123", status: "queued", from: "worker@x", accepted: ["control@x"], rejected: [], client_idempotency_key: req.headers["idempotency-key"], request_id: "r", content_hash: "h", idempotent_replay: false } }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => {
  server.closeAllConnections();
  server.close(() => r());
}));

function runWorker(manifest: unknown, extraEnv: Record<string, string> = {}): Promise<{ code: number | null; stderr: string }> {
  const runJs = fileURLToPath(new URL("../run.js", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runJs], {
      env: { PATH: process.env.PATH ?? "", MEDIAPACK_MANIFEST: Buffer.from(JSON.stringify(manifest)).toString("base64"),
        PRIMITIVE_WORKER_API_KEY: "prim_test_key", PRIMITIVE_API_BASE_URL: `${base}/v1`, ...extraEnv },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("worker subprocess exceeded 30 s")); }, 30_000);
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}

test("dist/run.js: extract_frames via control artifact-access + signed PUTs, result replied via Primitive SDK", async () => {
  const req = await makeReq("extract_frames", SETTINGS, { timestamps_ms: [45_139, 47_592] });
  const t0 = Date.now();
  const { code, stderr } = await runWorker({ work_request: req, reply_email_id: "em_inbound_1", worker_token: TOKEN, control_base_url: base });
  assert.equal(code, 0, stderr);
  assert.ok(Date.now() - t0 < 20_000);
  assert.ok(accessCalls.every((c) => c.auth === `Bearer ${TOKEN}`));
  const reply = replies.at(-1)!;
  assert.equal(reply.path, "/v1/emails/em_inbound_1/reply");
  assert.equal(reply.idem, resultIdempotencyKey(req.operation_id, 1));
  assert.equal(reply.auth, "Bearer prim_test_key");
  const result = WorkResult.parse(JSON.parse(reply.body.body_text));
  assert.equal(result.status, "succeeded");
  const frames = (result.result as { frames: { object_key: string; sha256: string; actual_ms: number }[] }).frames;
  assert.equal(frames.length, 2);
  for (const f of frames) {
    const put = puts.get(f.object_key);
    assert.ok(put, `uploaded ${f.object_key}`);
    assert.equal(sha256Hex(put.body), f.sha256);
    assert.equal(put.headers["content-type"], "image/jpeg");
    assert.equal(put.headers["x-upsert"], "false");
  }
  assert.doesNotMatch(stderr, /token=signed|prim_test_key|wt_test_token_value/, "logs must not leak secrets or signed URLs");
});

test("dist/run.js: a failed action still replies a failed WorkResult and exits 0; rejected token is non-retryable", async () => {
  const req = await makeReq("extract_frames", SETTINGS, { timestamps_ms: [1000] });
  const { code } = await runWorker({ work_request: req, reply_email_id: "em_inbound_2", worker_token: "wrong", control_base_url: base });
  assert.equal(code, 0);
  const result = WorkResult.parse(JSON.parse(replies.at(-1)!.body.body_text));
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "WORKER_FAILED");
  assert.equal(result.error?.retryable, false);
});

test("dist/run.js: invalid manifest with salvageable ids replies failed; unusable manifest exits 2", async () => {
  const req = await makeReq("extract_frames", SETTINGS, { timestamps_ms: [1000] });
  const bad = await runWorker({ work_request: { ...req, action: "rm_rf" }, reply_email_id: "em_inbound_3", worker_token: TOKEN, control_base_url: base });
  assert.equal(bad.code, 0);
  assert.equal(WorkResult.parse(JSON.parse(replies.at(-1)!.body.body_text)).status, "failed");
  const junk = await runWorker({ nope: true });
  assert.equal(junk.code, 2);
});

test("dist/run.js: delivery failure exits non-zero", async () => {
  const req = await makeReq("extract_frames", SETTINGS, { timestamps_ms: [1000] });
  const { code } = await runWorker({ work_request: req, reply_email_id: "em_x", worker_token: TOKEN, control_base_url: base }, { PRIMITIVE_API_BASE_URL: "http://127.0.0.1:1/v1" });
  assert.equal(code, 1);
});

test("REST fallback sink sends body_text + Idempotency-Key to /v1/emails/{id}/reply", async () => {
  const req = await makeReq("extract_frames", SETTINGS, { timestamps_ms: [1000] });
  const wr = WorkResult.parse({ schema_version: "mediapack.v1", kind: "work_result", operation_id: req.operation_id, generation: 3, status: "failed", artifacts: [], error: { code: "WORKER_FAILED", message: "x", retryable: true } });
  await new PrimitiveRestSink("prim_rest", { baseUrl: `${base}/v1` }).deliver("em_rest", wr);
  const r = replies.at(-1)!;
  assert.equal(r.path, "/v1/emails/em_rest/reply"); assert.equal(r.idem, `mp:${req.operation_id}:result:3`);
  assert.deepEqual(JSON.parse(r.body.body_text), JSON.parse(JSON.stringify(wr)));
  await new PrimitiveSdkSink("prim_sdk", { apiBaseUrl: `${base}/v1` }).deliver("em_sdk", wr);
  assert.equal(replies.at(-1)!.idem, `mp:${req.operation_id}:result:3`);
});

test("vendored contracts are identical to apps/mediapack/src/contracts/index.ts", () => {
  const canonical = fileURLToPath(new URL("../../../apps/mediapack/src/contracts/index.ts", import.meta.url));
  const vendored = fileURLToPath(new URL("../../src/contracts/index.ts", import.meta.url));
  let a: string;
  try { a = readFileSync(canonical, "utf8"); } catch { return; } // outside the monorepo (e.g. Docker build context)
  assert.equal(readFileSync(vendored, "utf8"), a, "run `npm run sync-contracts` in worker/");
});
