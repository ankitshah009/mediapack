#!/usr/bin/env node
// Start the compiled Next.js image behind a public Blaxel sandbox preview.
import { parseArgs, parseEnv } from 'node:util';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(new URL('../apps/mediapack/package.json', import.meta.url));
const { SandboxInstance, settings } = require('@blaxel/core');
class HostingError extends Error {}
let phase = 'validate local image and environment';
const { values } = parseArgs({ options: {
  image: { type: 'string' }, name: { type: 'string', default: 'mediapack-web' },
  workspace: { type: 'string', default: 'mediapack' }, region: { type: 'string', default: 'us-pdx-1' },
  'env-file': { type: 'string', default: 'apps/web/.env.blaxel' },
  'idle-ttl': { type: 'string', default: '1h' },
  restart: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
} });

// Keep the model alternative aligned with adapters/blaxel-launch.ts. A workspace
// token may be sent only to that same workspace's exact HTTPS model gateway.
function missingProviderSettings(env) {
  const required = ['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET', 'PRIMITIVE_API_KEY', 'PRIMITIVE_WORKER_API_KEY', 'PRIMITIVE_WEBHOOK_SECRET',
    'PRIMITIVE_CONTROL_ADDRESS', 'PRIMITIVE_WORKER_ADDRESS', 'BLAXEL_WORKER_IMAGE'];
  const missing = required.filter(key => !env[key]);
  if (!env.STRIPE_PROFILE_ID && !(env.PAYMENTS_MODE === 'test' && env.STRIPE_TEST_NETWORK_ID === 'internal')) {
    missing.push('STRIPE_PROFILE_ID or explicit STRIPE_TEST_NETWORK_ID=internal');
  }
  const workspace = env.BL_WORKSPACE || env.BLAXEL_PLAN_WORKSPACE;
  if (!workspace) missing.push('BL_WORKSPACE');
  if (!(env.BL_API_KEY || env.BLAXEL_PLAN_API_KEY || env.BL_CLIENT_CREDENTIALS)) missing.push('BL_API_KEY or BL_CLIENT_CREDENTIALS');
  let gateway = false;
  if (workspace && env.OPENAI_BASE_URL) {
    try {
      const url = new URL(env.OPENAI_BASE_URL);
      const parts = url.pathname.replace(/\/$/, '').split('/');
      gateway = url.origin === 'https://run.blaxel.ai' && !url.username && !url.password && !url.search && !url.hash &&
        parts.length === 5 && parts[1] === workspace && parts[2] === 'models' &&
        /^[a-z0-9][a-z0-9-]*$/.test(parts[3]) && parts[4] === 'v1';
    } catch { /* An invalid URL cannot satisfy the model authentication requirement. */ }
  }
  if (!env.OPENAI_API_KEY && !gateway) missing.push('OPENAI_API_KEY or valid Blaxel OPENAI_BASE_URL');
  return missing;
}

async function main() {
  if (values.help) {
    console.log('Usage: node scripts/host-blaxel.mjs --image sandbox/mediapack-web:<immutable-tag> [--env-file apps/web/.env.blaxel] [--idle-ttl 1h..24h] [--restart]\nCreates/reuses the web sandbox and its public preview. Runtime values stay out of build images and logs.\nIdle deletion defaults to 1h; use --idle-ttl 24h to keep a demo URL through judging. Standby remains enabled.\n--restart stops only this sandbox’s named web process before starting it with current configuration.\nUse a new --name for a new image; existing sandbox images are never silently replaced.');
    return;
  }
  const idleHours = /^([1-9]|1[0-9]|2[0-4])h$/.exec(values['idle-ttl']);
  if (!idleHours) throw new HostingError('--idle-ttl must be a whole number of hours between 1h and 24h.');
  const expirationPolicies = [{ type: 'ttl-idle', value: values['idle-ttl'], action: 'delete' }];
  if (!/^sandbox\/mediapack-web:[a-zA-Z0-9_.-]+$/.test(values.image ?? '') || values.image.endsWith(':latest')) {
    throw new HostingError('Supply the successfully built immutable sandbox/mediapack-web:<tag> image.');
  }
  const file = parseEnv(await readFile(resolve(root, values['env-file']), 'utf8'));
  const allowed = new Set([...Object.keys(parseEnv(await readFile(resolve(root, 'apps/web/.env.example'), 'utf8'))),
    'MPP_SECRET_KEY', 'MCP_PUBLIC_URL', 'BL_REGION', 'OPENAI_REASONING_EFFORT', 'OPENAI_IMAGE_DETAIL',
    'BLAXEL_PLAN_API_KEY', 'BLAXEL_PLAN_WORKSPACE']);
  const env = Object.fromEntries(Object.entries(file).filter(([key, value]) => allowed.has(key) && value.trim()));
  settings.setConfig({ ...settings.config, workspace: values.workspace });
  phase = 'create or retrieve the web sandbox';
  // Use the verified minimal API model. The shorthand injects extra generation
  // defaults; previews route directly to port 3000 without runtime port entries.
  const sandbox = await SandboxInstance.createIfNotExists({
    metadata: { name: values.name, labels: { app: 'mediapack', role: 'web' } },
    spec: { region: values.region, lifecycle: { expirationPolicies }, runtime: {
      image: values.image, memory: 2048,
      envs: [{ name: 'MEDIAPACK_HOST_MODE', value: 'sandbox' }, { name: 'BL_SANDBOX_USER_ENABLED', value: 'true' }],
    } },
  }, { timeout: 50 });
  if (sandbox.spec.runtime?.image !== values.image) throw new HostingError('Existing sandbox uses a different image. Choose a new --name for this release.');
  if (sandbox.spec.region !== values.region) throw new HostingError('Existing sandbox uses a different region. Choose a new --name.');
  // createIfNotExists preserves an existing resource, so enforce cost protection
  // on both new and previously deployed web hosts.
  phase = 'apply the bounded idle deletion policy';
  const updated = await SandboxInstance.updateLifecycle(values.name, { expirationPolicies });
  if (!updated.spec.lifecycle?.expirationPolicies?.some(p => p.type === 'ttl-idle' && p.value === values['idle-ttl'] && p.action === 'delete')) {
    throw new HostingError('Blaxel did not confirm the requested idle deletion policy. Check sandbox Lifecycle settings.');
  }
  phase = 'create or retrieve the public preview';
  const preview = await sandbox.previews.createIfNotExists({ metadata: { name: 'web' }, spec: { port: 3000, public: true } });
  if (!preview.spec?.public || preview.spec.port !== 3000) throw new HostingError('Existing web preview has a different privacy/port configuration; review it in the Blaxel Console.');
  const origin = new URL(preview.spec.url).origin;
  if (!origin.startsWith('https://')) throw new HostingError('Blaxel returned a non-HTTPS preview.');
  Object.assign(env, { NODE_ENV: 'production', PAYMENTS_MODE: 'test', PORT: '3000', PUBLIC_BASE_URL: origin,
    BL_WORKSPACE: values.workspace, BL_REGION: values.region });
  // Blaxel injects HOST for the sandbox interface; avoid assuming IPv4 routing.
  const processPrefix = 'mediapack-web';
  phase = 'start the compiled Next.js process';
  const processes = await sandbox.process.list();
  const ownedRunning = processes.filter(p => (p.name === processPrefix || p.name.startsWith(`${processPrefix}-`)) && p.status === 'running');
  const existing = ownedRunning[0];
  const restart = values.restart || existing?.keepAlive === true;
  if (restart) for (const p of ownedRunning) await sandbox.process.kill(String(p.pid));
  // Unique names keep old kill/restart callbacks and logs separate from a new
  // launch. Never reuse the process record that was just killed.
  const processName = existing && !restart ? existing.name : `${processPrefix}-${Date.now()}`;
  if (!existing || restart) {
    const launched = await sandbox.process.exec({ name: processName,
      command: 'HOSTNAME="${HOST:-0.0.0.0}" exec node apps/web/server.js', workingDir: '/app', env,
      waitForCompletion: false, restartOnFailure: true, maxRestarts: 5,
      // Poll readiness below instead of mixing an API startup-wait timeout
      // with the process lifetime. Standby must remain enabled.
      keepAlive: false,
    });
    if (['failed', 'killed', 'stopped', 'completed'].includes(launched.status)) throw new HostingError('Web process did not remain running. Inspect its private process logs in Blaxel.');
  }
  // Never print provider logs or SDK error payloads: either may contain runtime secrets.
  phase = 'verify Next.js boot and public health';
  let status, ready = false;
  const deadline = Date.now() + 30_000;
  do {
    status = await sandbox.process.get(processName);
    ready = /Ready in/.test(await sandbox.process.logs(processName));
    if (status.status !== 'running' || ready) break;
    await new Promise(done => setTimeout(done, 500));
  } while (Date.now() < deadline);
  if (status.status !== 'running' || !ready) throw new HostingError('Next.js did not report a ready running process. Inspect its private logs.');
  const health = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
  if (!health.ok) throw new HostingError(`Public health check returned HTTP ${health.status}.`);
  const healthBody = await health.json();
  const report = { sandbox: values.name, image: values.image, origin, app_url: `${origin}/app`,
    process: processName, process_status: status.status, next_ready: ready, health_status: health.status, database: healthBody.database,
    missing_provider_settings_in_env_file: missingProviderSettings(env),
    keep_alive: status.keepAlive,
    expiration_policies: updated.spec.lifecycle.expirationPolicies,
    lifecycle: `automatic standby allowed; sandbox and preview deleted after ${values['idle-ttl']} idle (resume/suspend-based timer)`,
    configuration: existing && !restart ? 'Existing process reused; use --restart to apply current env values.' : 'Current env applied; PUBLIC_BASE_URL set to preview origin.',
  };
  await mkdir(resolve(root, '.blaxel'), { recursive: true, mode: 0o700 });
  await writeFile(resolve(root, '.blaxel/web-host.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
// SDK mutations have no AbortSignal option. Bound this CLI run without retrying
// a request that could still be completing at the provider. The configured idle
// policy and disabled keep-alive remain in effect if this client exits.
const watchdog = setTimeout(() => {
  console.error(`Blaxel hosting exceeded 120 seconds during: ${phase}. Inspect the web sandbox in the Console before retrying.`);
  process.exit(1);
}, 120_000).unref();
main().catch(error => {
  // All external exception details are deliberately omitted.
  console.error(error instanceof HostingError ? error.message : `Blaxel hosting failed during: ${phase}. Check the env file, workspace login and private sandbox/process status in the Console. No provider credentials or raw logs were printed.`);
  if (!(error instanceof HostingError)) console.error(JSON.stringify({
    error_type: error?.constructor?.name,
    status: error?.status ?? error?.status_code ?? error?.response?.status,
    code: typeof error?.code === 'number' || /^[A-Z_]+$/.test(error?.code ?? '') ? error.code : undefined,
    field_names: Object.keys(error ?? {}),
  }));
  process.exitCode = 1;
}).finally(() => clearTimeout(watchdog));
