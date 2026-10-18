#!/usr/bin/env node
// Local source/config verification only. This helper never uploads or deploys.
import { parseArgs, parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join, relative } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const HELP = `Usage: node scripts/deploy-blaxel.mjs [--target web|worker|all] [--bin PATH]

Validates actual Blaxel CLI flags and locally renders deployment/source archives.
Prints safe summaries, credential presence and exact remote-build command arrays.
Does not upload, authenticate a real workspace, or deploy. Remote commands require
the user's authorized credited workspace. Web uses a sandbox public preview.

--bin PATH       CLI path (BLAXEL_CLI_BIN, default /tmp/mediapack-blaxel-bin/bl)
--target TARGET  web, worker or all (default all)
--env-file FILE  Server environment presence check (default apps/web/.env.local)
--help, -h       Show help
`;

async function run(bin, argv, cwd = root) {
  return new Promise((done, reject) => {
    const child = spawn(bin, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, BL_WORKSPACE: 'mediapack-config-probe', BL_API_KEY: '', BL_CLIENT_CREDENTIALS: '', DO_NOT_TRACK: '1',
    } });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI local preflight exceeded 60 seconds.')); }, 60_000);
    child.stdout.on('data', (v) => { out += v; });
    child.stderr.on('data', () => {}); // CLI may render credential diagnostics; never echo them.
    child.on('error', () => { clearTimeout(timer); reject(new Error('Blaxel CLI unavailable; use --bin or install the official CLI locally.')); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? done(out) : reject(new Error(`Blaxel local preflight exited ${code}; no cloud action was attempted.`)); });
  });
}

try {
  const { values: flags } = parseArgs({ options: { bin: { type: 'string' }, target: { type: 'string' }, 'env-file': { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  if (flags.help) { console.log(HELP); }
  else {
    const target = flags.target ?? 'all';
    if (!['all', 'web', 'worker'].includes(target)) throw new Error('--target must be web, worker or all.');
    const bin = flags.bin ?? process.env.BLAXEL_CLI_BIN ?? '/tmp/mediapack-blaxel-bin/bl';
    const version = (await run(bin, ['--version'])).trim();
    const help = await run(bin, ['deploy', '--help']);
    for (const flag of ['--dryrun', '--directory', '--type', '--recursive', '--env-file', '--yes', '--wait', '--timeout']) {
      if (!help.includes(flag)) throw new Error(`Installed deploy command lacks ${flag}; inspect its help before deployment.`);
    }
    const push = await run(bin, ['push', '--help']);
    for (const flag of ['--directory', '--type', '--yes', '--timeout']) if (!push.includes(flag)) throw new Error(`Installed push command lacks ${flag}.`);
    const reports = [];
    for (const item of target === 'all' ? ['web', 'worker'] : [target]) {
      const workingDirectory = item === 'web' ? root : join(root, 'worker');
      await access(join(workingDirectory, '.blaxelignore'));
      const type = 'sandbox';
      const text = await run(bin, ['deploy', '--directory', '.', '--type', type, '--recursive=false', '--env-file', '/dev/null', '--dryrun', '--yes', '--output', 'json'], workingDirectory);
      let rendered;
      try { rendered = JSON.parse(text.slice(text.indexOf('{'))); } catch { throw new Error('CLI dry-run did not produce a JSON deployment; raw output suppressed.'); }
      if (!rendered.dryRun || rendered.resources?.length !== 1) throw new Error('Expected one local dry-run resource.');
      const resource = rendered.resources[0];
      const files = rendered.files ?? [];
      const forbidden = files.filter((f) => (f.name ?? f.path ?? '').split('/').some((part) => part.startsWith('.env') || ['node_modules', '.git', '.venv', '.next', '.remember', '.playwright-mcp', 'fixtures', 'docs', '.aws', '.codex', '.agents', '.blaxel', '.projects', '.skills'].includes(part)));
      if (forbidden.length) throw new Error(`Source archive contains ${forbidden.length} excluded credential/data entries; fix .blaxelignore before any upload.`);
      if (item === 'web' && (resource.kind !== 'Sandbox' || resource.spec?.runtime?.ports?.[0]?.target !== 3000 || resource.spec?.runtime?.memory !== 2048)) throw new Error('CLI web sandbox configuration did not preserve type, port3000 and memory2048.');
      if (item === 'worker' && resource.kind !== 'Sandbox') throw new Error('Worker did not render as a sandbox.');
      if (item === 'worker' && !files.some((f) => f.name === 'package.json')) throw new Error('Worker archive is missing root package.json; invoke remote push from worker/.');
      // CLI 0.1.127 joins env-file to cwd even for an absolute path; emit a relative path.
      const environmentPath = relative(root, resolve(root, flags['env-file'] ?? 'apps/web/.env.local'));
      const argv = [bin, 'push', '--workspace', 'mediapack', '--type', 'sandbox', ...(item === 'web' ? ['--name', 'mediapack-web'] : []), '--yes', '--timeout', '20m'];
      reports.push({ target: item, kind: resource.kind, archive_files: files.length, excluded_entries: 0,
        ...(item === 'web' ? { port: 3000, memory: resource.spec.runtime.memory,
          hosting_command_after_build: ['node', 'scripts/host-blaxel.mjs', '--image', 'sandbox/mediapack-web:<built-immutable-tag>', '--env-file', environmentPath] } : {}),
        remote_working_directory: workingDirectory, remote_command_argv: argv });
    }
    let fileEnv = {};
    try { fileEnv = parseEnv(await readFile(resolve(root, flags['env-file'] ?? 'apps/web/.env.local'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Server environment file could not be parsed; content suppressed.'); }
    const configured = { ...fileEnv, ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v)) };
    console.log(JSON.stringify({ cli: version, mode: 'local_preflight_only', credential_presence: {
      BL_API_KEY: !!(configured.BL_API_KEY || configured.BLAXEL_PLAN_API_KEY), BL_WORKSPACE: !!(configured.BL_WORKSPACE || configured.BLAXEL_PLAN_WORKSPACE),
    }, cli_login_authentication: 'not checked by this local-only preflight; native bl login credentials are also supported', hosting: 'web sandbox public preview; Application Runtime not required', reports }, null, 2));
  }
} catch (error) { console.error(`mediapack Blaxel preflight: ${error.message}`); process.exitCode = 1; }
