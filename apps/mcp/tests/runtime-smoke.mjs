// Exercises the actual built CLI listener against a local HTTP fixture.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const video = "d8d46184-9342-4ba3-a015-968ec09d7616";
const seen = [];
const fixture = createServer((req, res) => {
  seen.push({ path: req.url, token: req.headers["x-mediapack-token"] });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ video_id: video, state: "ready" }));
});
fixture.listen(0, "127.0.0.1");
await once(fixture, "listening");
const reservation = createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const child = spawn(process.execPath, ["node_modules/mcp-use/dist/bin.js", "start", "--host", "127.0.0.1", "--port", String(port)], {
  env: { ...process.env, MEDIAPACK_API_URL: `http://127.0.0.1:${fixture.address().port}`, MCP_USE_ANONYMIZED_TELEMETRY: "false" },
  stdio: ["ignore", "pipe", "pipe"],
});
let boot = "";
child.stdout.on("data", (chunk) => { boot += chunk; });
child.stderr.on("data", (chunk) => { boot += chunk; });
try {
  const origin = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1000) });
      healthy = r.ok && (await r.json()).role === "manufact-mcp-proxy";
    } catch { /* wait for the fresh CLI process */ }
    if (healthy) break;
    if (child.exitCode !== null) throw new Error(`CLI exited ${child.exitCode}: ${boot}`);
    await delay(100);
  }
  assert.ok(healthy, boot);
  const rpc = async (method, params) => {
    const r = await fetch(`${origin}/mcp`, {
      method: "POST", signal: AbortSignal.timeout(5000),
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer runtime-smoke-capability" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = await r.text();
    assert.equal(r.status, 200, body);
    return r.headers.get("content-type").includes("text/event-stream") ? JSON.parse(body.split("\n").find((line) => line.startsWith("data: ")).slice(6)) : JSON.parse(body);
  };
  const listed = await rpc("tools/list", {});
  assert.equal(listed.result.tools.length, 9);
  const bound = listed.result.tools.filter((tool) => tool._meta?.ui || tool._meta?.["openai/outputTemplate"]);
  assert.equal(bound.length, 1);
  assert.equal(bound[0].name, "get_job");
  const called = await rpc("tools/call", { name: "get_video", arguments: { video_id: video } });
  assert.equal(called.result.structuredContent.video.state, "ready");
  assert.equal(seen[0].token, "runtime-smoke-capability");
  const resources = await rpc("resources/list", {});
  assert.equal(resources.result.resources.length, 1);
  const resource = await rpc("resources/read", { uri: resources.result.resources[0].uri });
  assert.ok(resource.result.contents[0].text.includes("<html"));
  console.log(boot.trim());
  console.log("Built CLI smoke passed: health, 9 tools, one get_job view, resource HTML, authenticated REST forwarding.");
} finally {
  if (child.exitCode === null) {
    const stopped = once(child, "exit");
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await stopped; } finally { clearTimeout(force); }
  }
  await new Promise((resolve) => fixture.close(resolve));
}
