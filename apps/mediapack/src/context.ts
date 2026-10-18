import { parseConfig } from "./config.js";
import { lazySql } from "./db.js";
import { launchWorker } from "./adapters/blaxel-launch.js";
import { createPrimitiveAdapter } from "./adapters/primitive.js";
import { createStripeAdapter } from "./adapters/stripe.js";
import { createSupabaseStorage } from "./adapters/storage.js";
import type { Ctx } from "./services/ctx.js";

export function createContext(options: Partial<Ctx> = {}): Ctx {
  const cfg = options.cfg ?? parseConfig();
  return {
    cfg,
    sql: options.sql ?? lazySql(cfg),
    storage: options.storage ?? createSupabaseStorage(cfg),
    stripe: options.stripe ?? createStripeAdapter(cfg),
    primitive: options.primitive ?? createPrimitiveAdapter(cfg),
    launchWorker: options.launchWorker ?? launchWorker,
    background: options.background ?? new Set(),
  };
}
