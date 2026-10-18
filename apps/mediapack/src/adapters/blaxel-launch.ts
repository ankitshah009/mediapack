// Launch payloads follow the installed @blaxel/core 0.3.30 types. User input is never
// interpolated into the process command, and the worker receives only scoped credentials.
import type { ProcessRequest, SandboxCreateConfiguration } from "@blaxel/core";
import { WorkRequest } from "../contracts/index.js";
import type { LaunchWorker, WorkerManifest } from "../services/ctx.js";

type Env = Record<string, string | undefined>;
type BlaxelSdk = typeof import("@blaxel/core");
type SandboxRecord = {
  metadata?: { name?: string; labels?: Record<string, string> };
  spec?: { runtime?: { image?: string } };
  status?: string;
  state?: string;
};
const WORKER_NAME = /^mp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-g[1-9]\d*$/;
const TERMINAL_PROCESSES = new Set(["completed", "failed", "killed", "stopped"]);
const SAFE_PROVIDER_CODES = new Set([
  "QUOTA_EXCEEDED", "RESOURCE_EXHAUSTED", "UNAUTHORIZED", "FORBIDDEN", "AUTHENTICATION_FAILED",
  "WORKSPACE_NOT_FOUND", "WORKLOAD_NOT_FOUND", "WORKLOAD_UNAVAILABLE", "INVALID_ARGUMENT",
  "INVALID_REQUEST", "DEPLOYMENT_FAILED", "TIMEOUT", "ETIMEDOUT", "ABORT_ERR",
]);
const WORKER_ENV = [
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_VISION_MODEL", "OPENAI_SEARCH_MODEL", "OPENAI_ASR_MODEL",
  "OPENAI_REASONING_EFFORT", "OPENAI_IMAGE_DETAIL", "PRIMITIVE_WORKER_API_KEY",
] as const;

/** Absent overrides leave the SDK free to use `bl login` or platform credentials. */
export function blaxelAuthConfig(env: Env = process.env) {
  const apiKey = env.BL_API_KEY || env.BLAXEL_PLAN_API_KEY;
  const workspace = env.BL_WORKSPACE || env.BLAXEL_PLAN_WORKSPACE;
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(!apiKey && env.BL_CLIENT_CREDENTIALS ? { clientCredentials: env.BL_CLIENT_CREDENTIALS } : {}),
    ...(workspace ? { workspace } : {}),
    integration: "mediapack/0.1.0",
  };
}

function usesModels(action: string): boolean {
  return action === "index_video" || action === "search_video";
}

// A workspace bearer token must only go to that workspace's verified gateway.
function hasBlaxelGateway(env: Env): boolean {
  const workspace = env.BL_WORKSPACE || env.BLAXEL_PLAN_WORKSPACE;
  if (!workspace || !env.OPENAI_BASE_URL) return false;
  try {
    const url = new URL(env.OPENAI_BASE_URL);
    const parts = url.pathname.replace(/\/$/, "").split("/");
    return url.origin === "https://run.blaxel.ai" && !url.username && !url.password && !url.search && !url.hash &&
      parts.length === 5 && parts[1] === workspace && parts[2] === "models" &&
      /^[a-z0-9][a-z0-9-]*$/.test(parts[3]!) && parts[4] === "v1";
  } catch { return false; }
}

export function workerLaunchSpec(manifest: WorkerManifest, env: Env = process.env): {
  sandbox: SandboxCreateConfiguration; process: ProcessRequest;
} {
  const request = WorkRequest.parse(manifest.work_request);
  if (!env.BLAXEL_WORKER_IMAGE) throw new Error("Set BLAXEL_WORKER_IMAGE to the built MediaPack worker image before launching work.");
  if (!env.PRIMITIVE_WORKER_API_KEY) throw new Error("Set PRIMITIVE_WORKER_API_KEY for worker result delivery.");
  if (usesModels(request.action) && !env.OPENAI_API_KEY && !hasBlaxelGateway(env)) {
    throw new Error("Set OPENAI_API_KEY, or set OPENAI_BASE_URL to this BL_WORKSPACE's Blaxel model gateway, for indexing and search work.");
  }
  const name = `mp-${request.operation_id}-g${request.generation}`;
  const workerEnv: Record<string, string> = {};
  for (const key of WORKER_ENV) {
    if (key.startsWith("OPENAI_") && !usesModels(request.action)) continue;
    if (env[key]) workerEnv[key] = env[key]!;
  }
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

function providerLaunchError(phase: "sandbox creation" | "process execution", error: unknown): Error {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const response = value.response && typeof value.response === "object" ? value.response as Record<string, unknown> : {};
  const nested = value.error && typeof value.error === "object" ? value.error as Record<string, unknown> : {};
  const status = [value.status, value.status_code, value.code, response.status].find(v =>
    typeof v === "number" && Number.isInteger(v) && v >= 400 && v <= 599);
  const code = [value.code, value.error, nested.code].find(v => typeof v === "string" && SAFE_PROVIDER_CODES.has(v));
  const detail = [status ? `HTTP ${status}` : undefined, code ? `code ${code}` : undefined].filter(Boolean).join(", ");
  // Never retain a provider cause: it can include request headers and runtime env.
  return new Error(`Blaxel ${phase} failed${detail ? ` (${detail})` : ""}. Check workspace capacity and runtime service-account access, then retry this operation after correcting the provider issue.`);
}

function ownedWorker(sandbox: SandboxRecord, image: string, excludedName: string): boolean {
  const name = sandbox.metadata?.name;
  return !!name && name !== excludedName && WORKER_NAME.test(name) &&
    sandbox.metadata?.labels?.app === "mediapack" && sandbox.spec?.runtime?.image === image && sandbox.status === "DEPLOYED";
}

/** Reclaim finished one-shot workers; never infer completion from standby alone. */
export async function reapCompletedWorkers(sdk: BlaxelSdk, image: string, excludedName: string,
  inFlightNames?: { has(name: string): boolean }): Promise<void> {
  const controller = new AbortController();
  const deadline = Date.now() + 10_000;
  const timer = setTimeout(() => controller.abort(), 10_000);
  const bounded = async <T>(promise: Promise<T>, until = deadline): Promise<T> => {
    if (controller.signal.aborted) throw new Error("cleanup deadline");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("cleanup deadline")), Math.max(1, until - Date.now()));
      })]);
    } finally { if (timeout) clearTimeout(timeout); }
  };
  try {
    const page = await bounded(sdk.listSandboxes({ query: { limit: 200, sort: "createdAt:asc" }, signal: controller.signal }));
    if (!page.response.ok || !page.data) return;
    const rows = Array.isArray(page.data) ? page.data : page.data.data;
    if (!Array.isArray(rows)) return;
    const candidates = rows.filter(row => ownedWorker(row, image, excludedName) &&
      !inFlightNames?.has(row.metadata.name) && row.state === "STANDBY").slice(0, 8);
    const requested: string[] = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(2, candidates.length) }, async () => {
      while (next < candidates.length && !controller.signal.aborted) {
        const candidate = candidates[next++]!;
        const name = candidate.metadata.name;
        try {
          const sandbox = await bounded(sdk.SandboxInstance.get(name));
          if (!ownedWorker(sandbox, image, excludedName)) continue;
          const processes = await bounded(sandbox.process.list());
          if (!Array.isArray(processes) || !processes.length ||
              processes.some(p => !TERMINAL_PROCESSES.has(p.status) || p.restartOnFailure === true) ||
              !processes.some(p => p.name === name && p.status === "completed" && p.exitCode === 0)) continue;
          if (controller.signal.aborted || Date.now() >= deadline) return;
          if (inFlightNames?.has(name)) continue;
          const deleted = await bounded(sdk.deleteSandbox({ path: { sandboxName: name }, signal: controller.signal }));
          if (deleted.response.ok || deleted.response.status === 404) requested.push(name);
        } catch { /* An unknown or inaccessible process is never safe to delete. */ }
      }
    }));
    // Deletion is asynchronous. Give accepted deletions a bounded opportunity to
    // free capacity before provisioning instead of immediately racing DELETING.
    const settleUntil = Math.min(deadline, Date.now() + 3_000);
    let pending = requested;
    while (pending.length && !controller.signal.aborted && Date.now() < settleUntil) {
      const remaining: string[] = [];
      await Promise.all(pending.map(async name => {
        try {
          const state = await bounded(sdk.getSandbox({ path: { sandboxName: name }, signal: controller.signal }), settleUntil);
          if (state.response.status !== 404 && state.data?.status !== "TERMINATED") remaining.push(name);
        } catch { remaining.push(name); }
      }));
      pending = remaining;
      if (pending.length) await bounded(new Promise<void>(resolve => setTimeout(resolve, 200)), settleUntil);
    }
  } catch { /* Cleanup is best effort; creation reports its own safe provider error. */ }
  finally { clearTimeout(timer); controller.abort(); }
}

/** Injectable at the SDK boundary so launch tests never provision resources. */
export function createBlaxelLauncher(options: {
  env?: Env;
  loadSdk?: () => Promise<BlaxelSdk>;
  getModelToken?: () => Promise<string>;
  reapWorkers?: (sdk: BlaxelSdk, image: string, excludedName: string) => Promise<void>;
  createSandbox?: (spec: SandboxCreateConfiguration) => Promise<{ process: { exec(request: ProcessRequest): Promise<{ name: string; status: string; exitCode: number }> } }>;
} = {}): LaunchWorker {
  // Configuring the SDK replaces its credential object. Share one initialization
  // across concurrent launches so one authentication cannot reset another's token.
  let sdkPromise: Promise<BlaxelSdk> | undefined;
  let reaping: Promise<void> | undefined;
  const inFlightNames = new Map<string, number>();
  const getSdk = () => (sdkPromise ??= (async () => {
    const sdk = await (options.loadSdk ? options.loadSdk() : import("@blaxel/core"));
    sdk.settings.setConfig({ ...sdk.settings.config, apiKey: undefined, clientCredentials: undefined,
      ...blaxelAuthConfig(options.env ?? process.env) });
    return sdk;
  })());
  return async (manifest) => {
    const env = options.env ?? process.env;
    const spec = workerLaunchSpec(manifest, env);
    const workerName = spec.sandbox.name!;
    inFlightNames.set(workerName, (inFlightNames.get(workerName) ?? 0) + 1);
    try {
      if (usesModels(manifest.work_request.action) && !env.OPENAI_API_KEY) {
        // With API-key authentication the SDK's token accessor returns that same
        // persistent key. Only OAuth or an explicit short-lived token provider may
        // cross the control-server/worker boundary.
        if ((env.BL_API_KEY || env.BLAXEL_PLAN_API_KEY) && !options.getModelToken) {
          throw new Error("Blaxel gateway workers require BL_CLIENT_CREDENTIALS authentication or a short-lived model-token provider; a persistent workspace API key cannot be forwarded to a worker.");
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const token = await Promise.race([
            options.getModelToken ? options.getModelToken() : (async () => {
              const { settings } = await getSdk();
              await settings.authenticate();
              if (settings.config.apiKey || settings.config.apikey ||
                  (settings.credentials as { apiKey?: unknown }).apiKey) {
                throw new Error("persistent API key authentication");
              }
              return settings.token;
            })(),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("deadline")), 20_000); }),
          ]);
          if (!token?.trim()) throw new Error("empty token");
          // Only this short-lived token enters the worker. Persistent service-account
          // credentials remain on the control server and never enter the manifest.
          spec.process.env = { ...spec.process.env, OPENAI_API_KEY: token };
        } catch {
          throw new Error("Blaxel model authentication failed within its 20-second deadline. Check the runtime service account and BL_WORKSPACE before retrying.");
        } finally { if (timer) clearTimeout(timer); }
      }
      let createSandbox = options.createSandbox;
      if (!createSandbox || options.reapWorkers) {
        const sdk = await getSdk();
        if (!reaping) {
          const reap = options.reapWorkers ?? ((sdk, image, name) => reapCompletedWorkers(sdk, image, name, inFlightNames));
          reaping = reap(sdk, env.BLAXEL_WORKER_IMAGE!, workerName)
            .finally(() => { reaping = undefined; });
        }
        await reaping;
        createSandbox ??= (sandbox) => sdk.SandboxInstance.createIfNotExists(sandbox, { timeout: 50 });
      }
      let sandbox: Awaited<ReturnType<NonNullable<typeof createSandbox>>>;
      try { sandbox = await createSandbox(spec.sandbox); }
      catch (error) { throw providerLaunchError("sandbox creation", error); }
      let launched: Awaited<ReturnType<typeof sandbox.process.exec>>;
      try { launched = await sandbox.process.exec(spec.process); }
      catch (error) { throw providerLaunchError("process execution", error); }
      if (["failed", "killed", "stopped"].includes(launched.status) || (launched.status === "completed" && launched.exitCode !== 0)) {
        throw new Error(`Worker process failed to start (status ${launched.status}, exit ${launched.exitCode}).`);
      }
      return { sandboxName: spec.sandbox.name!, processName: launched.name || spec.process.name! };
    } finally {
      const remaining = (inFlightNames.get(workerName) ?? 1) - 1;
      if (remaining) inFlightNames.set(workerName, remaining);
      else inFlightNames.delete(workerName);
    }
  };
}

export const launchWorker: LaunchWorker = createBlaxelLauncher();
