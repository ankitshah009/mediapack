import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Always starts a new disposable cluster; deliberately never reads DATABASE_URL. */
export async function startPostgres() {
  const bin = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
  const data = mkdtempSync(join(tmpdir(), "mediapack-control-test-"));
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const run = (name: string, args: string[]) => execFileSync(join(bin, name), args, { encoding: "utf8", timeout: 30_000, stdio: "pipe" });
  const stop = () => {
    try { run("pg_ctl", ["-D", data, "stop", "-m", "immediate"]); }
    finally { rmSync(data, { recursive: true, force: true }); }
  };
  try {
    run("initdb", ["-D", data, "-U", "postgres", "-A", "trust"]);
    run("pg_ctl", ["-D", data, "-o", `-p ${port} -h 127.0.0.1 -k ${data}`, "-l", join(data, "boot.log"), "start", "-w"]);
    const psql = ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q"];
    run("psql", [...psql, "-c", "create role anon; create role authenticated; create role service_role;"]);
    const migrations = fileURLToPath(new URL("../../../../supabase/migrations/", import.meta.url));
    for (const name of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) run("psql", [...psql, "-f", join(migrations, name)]);
    const bootLog = readFileSync(join(data, "boot.log"), "utf8");
    if (!bootLog.includes("ready to accept connections")) throw new Error("Postgres did not report ready");
    return { url: `postgres://postgres@127.0.0.1:${port}/postgres`, stop };
  } catch (error) {
    stop();
    throw error;
  }
}
