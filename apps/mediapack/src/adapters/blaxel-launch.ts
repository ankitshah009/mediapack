// Launch payloads follow the installed @blaxel/core 0.3.30 types. User input is never
// interpolated into the process command, and the worker receives only scoped credentials.
import type { ProcessRequest, SandboxCreateConfiguration } from "@blaxel/core";
import { WorkRequest } from "../contracts/index.js";
import type { LaunchWorker, WorkerManifest } from "../services/ctx.js";

type Env = Record<string, string | undefined>;
const WORKER_ENV = [
  "OPENAI_API_KEY", "OPENAI_VISION_MODEL", "OPENAI_SEARCH_MODEL", "OPENAI_ASR_MODEL",
  "OPENAI_REASONING_EFFORT", "OPENAI_IMAGE_DETAIL", "PRIMITIVE_WORKER_API_KEY",
] as const;

/** Absent overrides leave the SDK free to use `bl login` or platform credentials. */
export function blaxelAuthConfig(env: Env = process.env) {
  const apiKey = env.BL_API_KEY || env.BLAXEL_PLAN_API_KEY;
  const workspace = env.BL_WORKSPACE || env.BLAXEL_PLAN_WORKSPACE;
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(workspace ? { workspace } : {}),
    integration: "mediapack/0.1.0",
  };
}

export function workerLaunchSpec(manifest: WorkerManifest, env: Env = process.env): {
  sandbox: SandboxCreateConfiguration; process: ProcessRequest;
} {
  const request = WorkRequest.parse(manifest.work_request);
  if (!env.BLAXEL_WORKER_IMAGE) throw new Error("Set BLAXEL_WORKER_IMAGE to the built MediaPack worker image before launching work.");
  if (!env.PRIMITIVE_WORKER_API_KEY) throw new Error("Set PRIMITIVE_WORKER_API_KEY for worker result delivery.");
  if ((request.action === "index_video" || request.action === "search_video") && !env.OPENAI_API_KEY) {
    throw new Error("Set OPENAI_API_KEY for indexing and search work.");
  }
  const name = `mp-${request.operation_id}-g${request.generation}`;
  const workerEnv: Record<string, string> = {};
  for (const key of WORKER_ENV) if (env[key]) workerEnv[key] = env[key]!;
  workerEnv.MEDIAPACK_MANIFEST = Buffer.from(JSON.stringify({ ...manifest, work_request: request })).toString("base64");
  return {
    // TTL bounds retained sandbox resources even if control loses the launch response.
    sandbox: { name, image: env.BLAXEL_WORKER_IMAGE, region: env.BL_REGION || "us-pdx-1", memory: 4096, ttl: "30m", labels: { app: "mediapack" } },
    process: {
      name, command: "node dist/run.js", workingDir: "/app", env: workerEnv,
      keepAlive: true, timeout: request.action === "index_video" ? 600 : 120,
      waitForCompletion: false, restartOnFailure: false, maxRestarts: 0,
    },
  };
}

/** Injectable at the SDK boundary so launch tests never provision resources. */
export function createBlaxelLauncher(options: {
  env?: Env;
  createSandbox?: (spec: SandboxCreateConfiguration) => Promise<{ process: { exec(request: ProcessRequest): Promise<{ name: string; status: string; exitCode: number }> } }>;
} = {}): LaunchWorker {
  return async (manifest) => {
    const env = options.env ?? process.env;
    const spec = workerLaunchSpec(manifest, env);
    let createSandbox = options.createSandbox;
    if (!createSandbox) {
      const { SandboxInstance, settings } = await import("@blaxel/core");
      settings.setConfig({ ...settings.config, ...blaxelAuthConfig(env) });
      createSandbox = (sandbox) => SandboxInstance.createIfNotExists(sandbox, { timeout: 50 });
    }
    const sandbox = await createSandbox(spec.sandbox);
    const launched = await sandbox.process.exec(spec.process);
    if (["failed", "killed", "stopped"].includes(launched.status) || (launched.status === "completed" && launched.exitCode !== 0)) {
      throw new Error(`Worker process failed to start (status ${launched.status}, exit ${launched.exitCode}).`);
    }
    return { sandboxName: spec.sandbox.name!, processName: launched.name || spec.process.name! };
  };
}

export const launchWorker: LaunchWorker = createBlaxelLauncher();
