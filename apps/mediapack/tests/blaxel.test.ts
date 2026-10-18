import assert from "node:assert/strict";
import { test } from "node:test";
import { blaxelAuthConfig, createBlaxelLauncher, workerLaunchSpec } from "../src/adapters/blaxel-launch.js";
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
