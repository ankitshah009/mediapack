import { MCPServer } from "mcp-use";
import { bodyLimit } from "hono/body-limit";
import { parseConfig } from "./config.js";
import { lazySql } from "./db.js";
import { launchWorker } from "./adapters/blaxel-launch.js";
import { createPrimitiveAdapter } from "./adapters/primitive.js";
import { createStripeAdapter } from "./adapters/stripe.js";
import { createSupabaseStorage } from "./adapters/storage.js";
import { registerSystem } from "./routes/system.js";
import { registerV1 } from "./routes/v1.js";
import { registerViewer } from "./routes/viewer.js";
import { errorResponse } from "./routes/http.js";
import { AppError } from "./services/errors.js";
import type { Ctx } from "./services/ctx.js";
import { registerTools } from "./tools/index.js";

/** One composition root for REST, MCP and the browser; adapters stay lazy until used. */
export function buildServer(options: Partial<Ctx> = {}) {
  const cfg = options.cfg ?? parseConfig();
  const ctx: Ctx = {
    cfg,
    sql: options.sql ?? lazySql(cfg),
    storage: options.storage ?? createSupabaseStorage(cfg),
    stripe: options.stripe ?? createStripeAdapter(cfg),
    primitive: options.primitive ?? createPrimitiveAdapter(cfg),
    launchWorker: options.launchWorker ?? launchWorker,
    background: options.background ?? new Set(),
  };
  const server = new MCPServer({
    name: "mediapack", version: "1.0.0", title: "MediaPack",
    description: "Source-backed video search, frames and clips for agents. Stripe sandbox.",
    instructions: "Bootstrap a MediaPack client with POST /v1/clients and configure Authorization: Bearer <capability>. Upload, complete_upload, poll get_video, quote_video, pay the quote over HTTP, then poll get_job before searching. A payment outcome of reconciling means poll; never purchase again. Search results cite observations, not root causes. See /llms.txt for the full flow.",
    // Payload logs could contain capabilities, signed media URLs or private video text.
    logging: { enabled: false },
  });
  server.app.onError((e, c) => errorResponse(c, e));
  server.app.notFound((c) => errorResponse(c, new AppError("NOT_FOUND", "Endpoint not found.")));
  server.use("*", bodyLimit({
    maxSize: 1024 * 1024,
    onError: (c) => errorResponse(c, new AppError("INPUT_LIMIT_EXCEEDED", "Request body exceeds 1 MiB; upload media directly to the signed storage URL.")),
  }));
  server.use("*", async (c, next) => {
    await next();
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
    if (/^\/(?:v1|viewer|internal|webhooks)(?:\/|$)/.test(c.req.path)) c.header("cache-control", "no-store");
  });
  registerV1(server, ctx);
  registerViewer(server, ctx);
  registerSystem(server, ctx);
  registerTools(server, ctx);
  return { server, ctx };
}
