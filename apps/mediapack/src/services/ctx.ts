import type { Config } from "../config.js";
import type { Sql } from "../db.js";
import type { StorageAdapter } from "../adapters/storage.js";
import type { StripeAdapter } from "../adapters/stripe.js";
import type { PrimitiveAdapter } from "../adapters/primitive.js";
import type { WorkRequest } from "../contracts/index.js";

export interface WorkerManifest {
  work_request: WorkRequest;
  reply_email_id: string;
  worker_token: string;
  control_base_url: string;
}
export type LaunchWorker = (m: WorkerManifest) => Promise<{ sandboxName: string; processName: string }>;

export interface Ctx {
  cfg: Config;
  sql: Sql;
  storage: StorageAdapter;
  stripe: StripeAdapter;
  primitive: PrimitiveAdapter;
  launchWorker: LaunchWorker;
  /** In-flight fire-and-forget work (tests await drain()). */
  background: Set<Promise<unknown>>;
}

export function background(ctx: Ctx, p: Promise<unknown>, label: string): void {
  const tracked = p.catch((e) => console.error(`[background:${label}]`, e instanceof Error ? e.message : e)).finally(() => ctx.background.delete(tracked));
  ctx.background.add(tracked);
}

export async function drain(ctx: Ctx): Promise<void> {
  while (ctx.background.size) await Promise.all([...ctx.background]);
}

export const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
