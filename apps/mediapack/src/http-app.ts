import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createContext } from "./context.js";
import { registerV1 } from "./routes/v1.js";
import { registerViewer } from "./routes/viewer.js";
import { registerSystem } from "./routes/system.js";
import { errorResponse } from "./routes/http.js";
import { AppError } from "./services/errors.js";
import type { Ctx } from "./services/ctx.js";

/** In-process Web Request/Response router mounted by Next.js route handlers. No second server. */
export function buildHttpApp(options: Partial<Ctx> = {}) {
  const ctx = createContext(options);
  const app = new Hono();
  app.onError((e, c) => errorResponse(c, e));
  app.notFound((c) => errorResponse(c, new AppError("NOT_FOUND", "Endpoint not found.")));
  app.use("*", bodyLimit({
    maxSize: 1024 * 1024,
    onError: (c) => errorResponse(c, new AppError("INPUT_LIMIT_EXCEEDED", "Request body exceeds 1 MiB; upload media directly to the signed storage URL.")),
  }));
  app.use("*", async (c, next) => {
    await next();
    // Provider webhook errors keep their protocol status and gain the same actionable envelope.
    if (c.res.status >= 400 && c.res.headers.get("content-type")?.includes("application/json")) {
      const body = await c.res.clone().json().catch(() => null);
      if (body?.error && !body.hint) {
        const headers = new Headers(c.res.headers);
        headers.delete("content-length");
        c.res = new Response(JSON.stringify({
          ...body,
          hint: body.error.message ?? "The request could not be completed.",
          next_action: body.error.next_action ?? "Resolve the reported error before retrying this request.",
        }), { status: c.res.status, headers });
      }
    }
    c.header("cache-control", "no-store");
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
  });
  registerV1(app, ctx);
  registerViewer(app, ctx);
  registerSystem(app, ctx, { serveStatic: false });
  return { app, ctx };
}
