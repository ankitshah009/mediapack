import { spawn } from "node:child_process";

export interface RunOptions {
  timeoutMs: number;
  /** Max bytes kept from stdout / stderr each (excess is dropped, not an error). */
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  elapsedMs: number;
}

/** Every spawn goes through here so tests can assert the no-shell invariant. */
export const spawnLog: { cmd: string; args: readonly string[]; shell: false }[] = [];

/**
 * Run a fixed binary with an argument ARRAY. Never uses a shell: user input (queries, filenames, URLs)
 * can never be interpreted as shell syntax. Kills the child with SIGKILL on timeout or abort.
 */
export function run(cmd: string, args: readonly string[], opts: RunOptions): Promise<RunResult> {
  if (!/^[A-Za-z0-9_./-]+$/.test(cmd)) throw new Error(`refusing to spawn suspicious command name: ${cmd}`);
  for (const a of args) if (typeof a !== "string") throw new Error("spawn arguments must be strings");
  opts.signal?.throwIfAborted();
  const max = opts.maxOutputBytes ?? 4 * 1024 * 1024;
  const started = Date.now();
  spawnLog.push({ cmd, args: [...args], shell: false });
  if (spawnLog.length > 1000) spawnLog.splice(0, spawnLog.length - 1000);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out: Buffer = Buffer.alloc(0);
    let err: Buffer = Buffer.alloc(0);
    let timedOut = false;
    const append = (buf: Buffer, chunk: Buffer) => (buf.length >= max ? buf : Buffer.concat([buf, chunk.subarray(0, max - buf.length)]));
    child.stdout.on("data", (c: Buffer) => { out = append(out, c); });
    child.stderr.on("data", (c: Buffer) => { err = append(err, c); });
    const kill = () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs);
    const onAbort = () => { timedOut = true; kill(); };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();
    child.on("error", (e) => { clearTimeout(timer); opts.signal?.removeEventListener("abort", onAbort); reject(e); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code, signal, stdout: out.toString("utf8"), stderr: err.toString("utf8"), timedOut, elapsedMs: Date.now() - started });
    });
  });
}

/** Run and require exit 0; error message carries a short stderr tail (no URLs are ever passed to ffmpeg). */
export async function runOk(cmd: string, args: readonly string[], opts: RunOptions): Promise<RunResult> {
  const r = await run(cmd, args, opts);
  if (r.timedOut) throw new Error(`${cmd} timed out after ${opts.timeoutMs} ms`);
  if (r.code !== 0) throw new Error(`${cmd} exited ${r.code ?? r.signal}: ${r.stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 400)}`);
  return r;
}
