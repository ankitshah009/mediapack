import assert from "node:assert/strict";
import { test } from "node:test";
import { blaxelAuthConfig, createBlaxelLauncher, reapCompletedWorkers, workerLaunchSpec } from "../src/adapters/blaxel-launch.js";
import type { WorkerManifest } from "../src/services/ctx.js";

const id = "11111111-1111-4111-8111-111111111111";
const manifest: WorkerManifest = {
  work_request: { schema_version: "mediapack.v1", kind: "work_request", operation_id: id, job_id: null,
    video_id: id, action: "probe_video", source_sha256: null, terms_hash: null, generation: 2,
    media_ref: { object_key: `${id}/source.mp4` }, input: {}, reply_to_operation: id },
  reply_email_id: "email_inbound", worker_token: "scoped-worker-token", control_base_url: "https://control.example",
};
const env = { BLAXEL_WORKER_IMAGE: "registry.example/mediapack:verified", PRIMITIVE_WORKER_API_KEY: "worker-key", OPENAI_API_KEY: "model-key" };

test("native CLI login is preserved and explicit native/Projects credentials remain supported", () => {
  assert.deepEqual(blaxelAuthConfig({}), { integration: "mediapack/0.1.0" });
  assert.deepEqual(blaxelAuthConfig({ BL_WORKSPACE: "mediapack" }), { workspace: "mediapack", integration: "mediapack/0.1.0" });
  assert.deepEqual(blaxelAuthConfig({ BLAXEL_PLAN_API_KEY: "projects-key", BLAXEL_PLAN_WORKSPACE: "projects-workspace" }), { apiKey: "projects-key", workspace: "projects-workspace", integration: "mediapack/0.1.0" });
  assert.equal(blaxelAuthConfig({ BL_API_KEY: "native", BLAXEL_PLAN_API_KEY: "alias" }).apiKey, "native");
  assert.deepEqual(blaxelAuthConfig({ BL_CLIENT_CREDENTIALS: "private-client-pair", BL_WORKSPACE: "mediapack" }), {
    clientCredentials: "private-client-pair", workspace: "mediapack", integration: "mediapack/0.1.0",
  });
  assert.equal(blaxelAuthConfig({ BL_API_KEY: "native", BL_CLIENT_CREDENTIALS: "private-client-pair" }).clientCredentials, undefined);
});

test("Blaxel launch uses a fixed command, bounded lifetime, full operation identity and scoped environment", () => {
  const spec = workerLaunchSpec(manifest, { ...env, DATABASE_URL: "secret-db", STRIPE_SECRET_KEY: "secret-payment", SUPABASE_SERVICE_ROLE_KEY: "secret-storage", PRIMITIVE_API_KEY: "control-key" });
  assert.equal(spec.sandbox.name, `mp-${id}-g2`);
  assert.equal(spec.sandbox.ttl, "30m");
  assert.equal(spec.sandbox.memory, 4096);
  assert.equal(spec.sandbox.region, "us-pdx-1");
  assert.equal(spec.process.name, spec.sandbox.name);
  assert.equal(spec.process.command, "node dist/run.js");
  assert.equal(spec.process.workingDir, "/app");
  assert.equal(spec.process.keepAlive, true);
  assert.equal(spec.process.timeout, 120);
  assert.equal(spec.process.waitForCompletion, false);
  assert.equal(spec.process.restartOnFailure, false);
  assert.deepEqual(JSON.parse(Buffer.from(spec.process.env!.MEDIAPACK_MANIFEST, "base64").toString()), manifest);
  for (const key of ["DATABASE_URL", "STRIPE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY", "PRIMITIVE_API_KEY"]) assert.equal(spec.process.env![key], undefined);
  assert.equal(spec.process.env!.OPENAI_API_KEY, undefined, "media-only work does not receive model credentials");
  const index = workerLaunchSpec({ ...manifest, work_request: { ...manifest.work_request, action: "index_video" } }, env);
  assert.equal(index.process.timeout, 600);
});

test("Blaxel configuration fails before provisioning when image, delivery or model credentials are missing", () => {
  assert.throws(() => workerLaunchSpec(manifest, {}), /BLAXEL_WORKER_IMAGE/);
  assert.throws(() => workerLaunchSpec(manifest, { BLAXEL_WORKER_IMAGE: "image" }), /PRIMITIVE_WORKER_API_KEY/);
  assert.throws(() => workerLaunchSpec({ ...manifest, work_request: { ...manifest.work_request, action: "search_video" } }, { ...env, OPENAI_API_KEY: undefined }), /OPENAI_API_KEY/);
});

test("Blaxel launcher dispatches the typed SDK payload and returns the actual process identity", async () => {
  let called = 0;
  const launcher = createBlaxelLauncher({ env, createSandbox: async (sandbox) => {
    called++;
    assert.equal(sandbox.image, env.BLAXEL_WORKER_IMAGE);
    assert.equal(sandbox.memory, 4096);
    return { process: { exec: async (process) => {
      assert.equal(process.command, "node dist/run.js");
      return { name: "actual-process-name", status: "running", exitCode: 0 };
    } } };
  } });
  assert.deepEqual(await launcher(manifest), { sandboxName: `mp-${id}-g2`, processName: "actual-process-name" });
  assert.equal(called, 1);
});

test("Blaxel immediate process failure is reported as a launch failure", async () => {
  const launcher = createBlaxelLauncher({ env, createSandbox: async () => ({ process: { exec: async () => ({ name: "failed", status: "failed", exitCode: 2 }) } }) });
  await assert.rejects(launcher(manifest), /failed to start/);
});

const gatewayEnv = { BLAXEL_WORKER_IMAGE: env.BLAXEL_WORKER_IMAGE, PRIMITIVE_WORKER_API_KEY: "worker-key",
  BL_WORKSPACE: "mediapack", BL_CLIENT_CREDENTIALS: "persistent-server-secret",
  OPENAI_BASE_URL: "https://run.blaxel.ai/mediapack/models/sandbox-openai/v1", OPENAI_VISION_MODEL: "gpt-4o-mini" };
const searchManifest: WorkerManifest = { ...manifest, work_request: { ...manifest.work_request, action: "search_video" } };

test("gateway launches mint a fresh token per operation and keep persistent credentials out of workers", async () => {
  const received: Record<string, string>[] = [];
  let tokens = 0;
  const launcher = createBlaxelLauncher({ env: gatewayEnv, getModelToken: async () => `short-lived-${++tokens}`,
    createSandbox: async () => ({ process: { exec: async process => {
      received.push(process.env!);
      return { name: "model-worker", status: "running", exitCode: 0 };
    } } }),
  });
  await launcher(searchManifest);
  await launcher({ ...searchManifest, work_request: { ...searchManifest.work_request, action: "index_video" } });
  assert.equal(tokens, 2);
  assert.equal(received[0]!.OPENAI_API_KEY, "short-lived-1");
  assert.equal(received[1]!.OPENAI_API_KEY, "short-lived-2");
  assert.equal(received[0]!.OPENAI_BASE_URL, gatewayEnv.OPENAI_BASE_URL);
  assert.equal(received[0]!.OPENAI_VISION_MODEL, "gpt-4o-mini");
  assert.equal(received[0]!.BL_CLIENT_CREDENTIALS, undefined);
  assert.equal(JSON.stringify(received).includes(gatewayEnv.BL_CLIENT_CREDENTIALS), false);
});

test("a Blaxel token is never requested for another workspace, host, query or credential-bearing URL", async () => {
  let called = false;
  for (const url of ["https://other.example/mediapack/models/sandbox-openai/v1",
    "https://run.blaxel.ai/other-workspace/models/sandbox-openai/v1",
    `${gatewayEnv.OPENAI_BASE_URL}?redirect=elsewhere`, "https://user:password@run.blaxel.ai/mediapack/models/sandbox-openai/v1",
    "http://run.blaxel.ai/mediapack/models/sandbox-openai/v1"]) {
    const launcher = createBlaxelLauncher({ env: { ...gatewayEnv, OPENAI_BASE_URL: url },
      getModelToken: async () => { called = true; return "token"; },
      createSandbox: async () => { called = true; throw new Error("must not create"); },
    });
    await assert.rejects(launcher(searchManifest), /OPENAI_BASE_URL/);
  }
  assert.equal(called, false);
});

test("gateway authentication failure or empty token creates no sandbox and withholds provider details", async () => {
  let created = false;
  for (const getModelToken of [async () => "", async () => { throw new Error("private-authentication-payload"); }]) {
    const launcher = createBlaxelLauncher({ env: gatewayEnv, getModelToken,
      createSandbox: async () => { created = true; throw new Error("must not create"); } });
    await assert.rejects(launcher(searchManifest), error => {
      assert.match(String(error), /Blaxel model authentication failed/);
      assert.equal(String(error).includes("private-authentication-payload"), false);
      return true;
    });
  }
  assert.equal(created, false);
});

test("native and Projects API keys cannot be mistaken for short-lived gateway tokens", async () => {
  let created = false;
  for (const credentials of [{ BL_API_KEY: "persistent-workspace-key" }, { BLAXEL_PLAN_API_KEY: "persistent-projects-key" }]) {
    const launcher = createBlaxelLauncher({ env: { ...gatewayEnv, ...credentials },
      createSandbox: async () => { created = true; throw new Error("must not create"); } });
    await assert.rejects(launcher(searchManifest), error => {
      assert.match(String(error), /persistent workspace API key cannot be forwarded/);
      assert.equal(String(error).includes(Object.values(credentials)[0]!), false);
      return true;
    });
  }
  assert.equal(created, false);
});

test("concurrent gateway launches authenticate against one stable SDK credential instance", async () => {
  let resets = 0;
  let token = "";
  const authentications: (() => void)[] = [];
  const workerTokens: string[] = [];
  const sdk = {
    settings: {
      config: {},
      credentials: {},
      setConfig() { resets++; token = ""; },
      async authenticate() {
        const instance = resets;
        await new Promise<void>(resolve => authentications.push(resolve));
        if (instance === resets) token = `short-lived-instance-${instance}`;
      },
      get token() { return token; },
    },
  } as unknown as typeof import("@blaxel/core");
  const launcher = createBlaxelLauncher({ env: gatewayEnv, loadSdk: async () => sdk,
    createSandbox: async () => ({ process: { exec: async process => {
      workerTokens.push(process.env!.OPENAI_API_KEY!);
      return { name: "concurrent-worker", status: "running", exitCode: 0 };
    } } }),
  });
  const first = launcher(searchManifest);
  while (authentications.length < 1) await new Promise<void>(resolve => setImmediate(resolve));
  const second = launcher({ ...searchManifest, work_request: { ...searchManifest.work_request, action: "index_video" } });
  while (authentications.length < 2) await new Promise<void>(resolve => setImmediate(resolve));
  authentications[0]!();
  await first;
  authentications[1]!();
  await second;
  assert.equal(resets, 1);
  assert.deepEqual(workerTokens, ["short-lived-instance-1", "short-lived-instance-1"]);
});

test("an API key discovered by the native CLI is withheld from gateway workers", async () => {
  let created = false;
  const sdk = { settings: {
    config: {}, credentials: { apiKey: "persistent-native-cli-key" },
    setConfig() {}, authenticate: async () => {}, get token() { return "persistent-native-cli-key"; },
  } } as unknown as typeof import("@blaxel/core");
  const launcher = createBlaxelLauncher({ env: gatewayEnv, loadSdk: async () => sdk,
    createSandbox: async () => { created = true; throw new Error("must not create"); } });
  await assert.rejects(launcher(searchManifest), error => {
    assert.match(String(error), /model authentication failed/);
    assert.equal(String(error).includes("persistent-native-cli-key"), false);
    return true;
  });
  assert.equal(created, false);
});

test("probe work neither requests nor receives a gateway model token", async () => {
  let tokens = 0;
  const launcher = createBlaxelLauncher({ env: gatewayEnv, getModelToken: async () => { tokens++; return "token"; },
    createSandbox: async () => ({ process: { exec: async process => {
      assert.equal(process.env!.OPENAI_API_KEY, undefined);
      assert.equal(process.env!.OPENAI_BASE_URL, undefined);
      return { name: "probe", status: "running", exitCode: 0 };
    } } }),
  });
  await launcher(manifest);
  assert.equal(tokens, 0);
});

const cleanupImage = "sandbox/mediapack-worker:verified-release";
const workerName = (n: number) => `mp-22222222-2222-4222-8222-${String(n).padStart(12, "0")}-g1`;
const cleanupRow = (n: number) => ({ metadata: { name: workerName(n), labels: { app: "mediapack" } },
  spec: { runtime: { image: cleanupImage } }, status: "DEPLOYED", state: "STANDBY" });
const finishedProcess = (name: string) => ({ name, status: "completed", exitCode: 0 });

function cleanupSdk(rows: ReturnType<typeof cleanupRow>[], overrides: Record<string, unknown> = {}) {
  const deleted: string[] = [], inspected: string[] = [], order: string[] = [];
  const reads = new Map<string, number>();
  const sdk = {
    settings: { config: {}, setConfig() {} },
    async listSandboxes() { return { response: new Response(), data: { data: rows, meta: { hasMore: false } } }; },
    SandboxInstance: {
      async get(name: string) {
        inspected.push(name);
        return { ...rows.find(row => row.metadata.name === name), process: { async list() {
          const value = overrides[name];
          if (value instanceof Error) throw value;
          return value ?? [finishedProcess(name)];
        } } };
      },
      async createIfNotExists(spec: { name: string }) {
        order.push("create");
        return { process: { async exec() { return { name: spec.name, status: "running", exitCode: 0 }; } } };
      },
    },
    async deleteSandbox({ path }: { path: { sandboxName: string } }) {
      deleted.push(path.sandboxName); order.push("delete");
      return { response: new Response(), data: {} };
    },
    async getSandbox({ path }: { path: { sandboxName: string } }) {
      const count = (reads.get(path.sandboxName) ?? 0) + 1;
      reads.set(path.sandboxName, count); order.push(count === 1 ? "deleting" : "gone");
      return count === 1 ? { response: new Response(), data: { status: "DELETING" } } :
        { response: new Response(null, { status: 404 }), error: { code: 404 } };
    },
  } as unknown as typeof import("@blaxel/core");
  return { sdk, deleted, inspected, order, reads };
}

test("reaping deletes only exact owned finished workers from the configured release", async () => {
  const rows = Array.from({ length: 7 }, (_, i) => cleanupRow(i + 1));
  rows.push({ ...cleanupRow(8), metadata: { name: "mediapack-web-r5", labels: { app: "mediapack" } } });
  rows.push({ ...cleanupRow(9), metadata: { name: workerName(9), labels: { app: "another-app" } } });
  rows.push({ ...cleanupRow(10), spec: { runtime: { image: "sandbox/mediapack-worker:other-release" } } });
  rows.push({ ...cleanupRow(11), metadata: { name: "mp-short-id-g1", labels: { app: "mediapack" } } });
  rows.push(cleanupRow(12));
  const f = cleanupSdk(rows, {
    [workerName(2)]: [{ name: workerName(2), status: "running", exitCode: 0 }],
    [workerName(3)]: [{ name: workerName(3), status: "completed", exitCode: 1 }],
    [workerName(4)]: [{ name: "different-process", status: "completed", exitCode: 0 }],
    [workerName(5)]: [finishedProcess(workerName(5)), { name: "active-child", status: "running", exitCode: 0 }],
    [workerName(6)]: [{ name: workerName(6), status: "unknown", exitCode: 0 }],
    [workerName(7)]: new Error("private provider failure"),
  });
  await reapCompletedWorkers(f.sdk, cleanupImage, workerName(12));
  assert.deepEqual(f.deleted, [workerName(1)]);
  assert.equal(f.inspected.includes("mediapack-web-r5"), false);
  assert.equal(f.inspected.includes(workerName(9)), false);
  assert.equal(f.inspected.includes(workerName(10)), false);
  assert.equal(f.inspected.includes("mp-short-id-g1"), false);
  assert.equal(f.inspected.includes(workerName(12)), false);
  assert.equal(f.reads.get(workerName(1)), 2, "accepted deletion is observed until the resource disappears");
});

test("default provisioning waits for bounded completed-worker deletion readback", async () => {
  const f = cleanupSdk([cleanupRow(1)]);
  const launcher = createBlaxelLauncher({ env: { ...env, BLAXEL_WORKER_IMAGE: cleanupImage }, loadSdk: async () => f.sdk });
  await launcher(manifest);
  assert.deepEqual(f.order, ["delete", "deleting", "gone", "create"]);
});

test("reaping rechecks ownership and skips a concurrently launching or restart-enabled worker", async () => {
  const f = cleanupSdk([cleanupRow(1), cleanupRow(2), cleanupRow(3)], {
    [workerName(2)]: [{ ...finishedProcess(workerName(2)), restartOnFailure: true }],
  });
  const get = f.sdk.SandboxInstance.get;
  f.sdk.SandboxInstance.get = async name => {
    const sandbox = await get(name);
    if (name === workerName(3)) sandbox.spec.runtime!.image = "sandbox/another-image:latest";
    return sandbox;
  };
  await reapCompletedWorkers(f.sdk, cleanupImage, "current-worker", new Set([workerName(1)]));
  assert.deepEqual(f.deleted, []);
  assert.equal(f.inspected.includes(workerName(1)), false);
});

test("cleanup accepts an already-gone delete and does not trust an unsuccessful deletion", async () => {
  const f = cleanupSdk([cleanupRow(1), cleanupRow(2)]);
  f.sdk.deleteSandbox = async ({ path }) => {
    f.deleted.push(path.sandboxName);
    return { response: new Response(null, { status: path.sandboxName === workerName(1) ? 404 : 403 }), error: { code: 403 } } as never;
  };
  await reapCompletedWorkers(f.sdk, cleanupImage, "current-worker");
  assert.equal(f.reads.has(workerName(1)), true);
  assert.equal(f.reads.has(workerName(2)), false);
});

test("cleanup bounds one pass to eight workers and ignores inaccessible list responses", async () => {
  const f = cleanupSdk(Array.from({ length: 10 }, (_, i) => cleanupRow(i + 1)));
  await reapCompletedWorkers(f.sdk, cleanupImage, "current-worker");
  assert.equal(f.deleted.length, 8);
  const denied = cleanupSdk([cleanupRow(1)]);
  denied.sdk.listSandboxes = async () => ({ response: new Response(null, { status: 403 }), error: { code: 403 } }) as never;
  await reapCompletedWorkers(denied.sdk, cleanupImage, "current-worker");
  assert.deepEqual(denied.deleted, []);
});

test("cleanup's deadline prevents a delayed process lookup from deleting anything later", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = cleanupSdk([cleanupRow(1)]);
  let ready!: () => void, finish!: (value: unknown) => void;
  const lookupStarted = new Promise<void>(resolve => { ready = resolve; });
  const processLookup = new Promise(resolve => { finish = resolve; });
  f.sdk.SandboxInstance.get = async () => ({ ...cleanupRow(1), process: { list: () => {
    ready(); return processLookup;
  } } }) as never;
  const reaping = reapCompletedWorkers(f.sdk, cleanupImage, "current-worker");
  await lookupStarted;
  t.mock.timers.tick(10_000);
  await reaping;
  finish([finishedProcess(workerName(1))]);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(f.deleted, []);
});

test("concurrent launches share cleanup and injected provisioning does not cause default cloud cleanup", async () => {
  let release!: () => void, passes = 0, loads = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = cleanupSdk([]);
  const createSandbox = async () => ({ process: { exec: async () => ({ name: "test", status: "running", exitCode: 0 }) } });
  const fakeOnly = createBlaxelLauncher({ env, loadSdk: async () => { throw new Error("unexpected SDK I/O"); }, createSandbox });
  await fakeOnly(manifest);
  const launcher = createBlaxelLauncher({ env, loadSdk: async () => { loads++; return f.sdk; }, createSandbox,
    reapWorkers: async () => { passes++; await gate; } });
  const first = launcher(manifest), second = launcher(manifest);
  while (!passes) await new Promise<void>(resolve => setImmediate(resolve));
  release(); await Promise.all([first, second]);
  assert.equal(passes, 1); assert.equal(loads, 1);
});

test("structured provisioning errors retain only phase, HTTP status and allowlisted codes", async () => {
  const secret = "private-secret-token";
  for (const failure of [
    { code: 429, error: "QUOTA_EXCEEDED", message: secret, request: { headers: { authorization: secret } } },
    { status: 403, code: secret, message: secret },
    new Error(secret),
  ]) {
    const launcher = createBlaxelLauncher({ env, createSandbox: async () => { throw failure; } });
    await assert.rejects(launcher(manifest), error => {
      const text = String(error);
      assert.match(text, /Blaxel sandbox creation failed/);
      assert.match(text, /Check workspace capacity and runtime service-account access/);
      assert.equal(text.includes(secret), false); assert.equal("cause" in (error as Error), false);
      if ("code" in failure && failure.code === 429) assert.match(text, /HTTP 429, code QUOTA_EXCEEDED/);
      return true;
    });
  }
  const launcher = createBlaxelLauncher({ env, createSandbox: async () => ({ process: {
    exec: async () => { throw { response: { status: 503 }, error: { code: "WORKLOAD_UNAVAILABLE" }, body: secret }; },
  } }) });
  await assert.rejects(launcher(manifest), /Blaxel process execution failed \(HTTP 503, code WORKLOAD_UNAVAILABLE\)/);
});
