// Direct Postgres access (porsager `postgres`) on DATABASE_URL. Pooled Supabase connections need prepare:false.
import postgres from "postgres";
import { requireDatabaseUrl, type Config } from "./config.js";

export type Sql = postgres.Sql;

export function createSql(cfg: Config): Sql {
  return postgres(requireDatabaseUrl(cfg), {
    max: 10,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
  });
}

/** Lazily-created singleton so the server boots (health, MCP introspection) without DATABASE_URL. */
export function lazySql(cfg: Config): Sql {
  let inst: Sql | undefined;
  const get = () => (inst ??= createSql(cfg));
  return new Proxy((() => {}) as unknown as Sql, {
    apply: (_t, _this, args) => (get() as unknown as (...a: unknown[]) => unknown)(...args),
    get: (_t, prop) => {
      const target = get() as unknown as Record<string | symbol, unknown>;
      const v = target[prop];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}
