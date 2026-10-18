import type { RouteHost } from "./http.js";
import { z } from "zod";
import { assertAllowedOrigin, authenticate, clearSessionCookie, errorResponse, guard, readBody, setSessionCookie, sourceOf } from "./http.js";
import { consumeViewerCode, createClient, signSession } from "../services/clients.js";
import type { Ctx } from "../services/ctx.js";
import { demoPurchase, prewarmDemoBuyer } from "../services/demoBuyer.js";
import { AppError } from "../services/errors.js";

const nostore = { "cache-control": "no-store" };

export function registerViewer(server: RouteHost, ctx: Ctx) {
  prewarmDemoBuyer(ctx);

  // Consume a CLI-issued one-time code; the cookie is a signed session for the SAME client (no second owner).
  server.post("/viewer/session", guard(async (c) => {
    assertAllowedOrigin(ctx, c);
    const { code } = await readBody(c, z.object({ code: z.string().min(8).max(200) }), false);
    const clientId = await consumeViewerCode(ctx, code.trim());
    const s = signSession(ctx, clientId);
    setSessionCookie(ctx, c, s.value, s.maxAge);
    return c.json({ ok: true, client_id: clientId }, 200, nostore);
  }));

  // Browser creates its own client (humans uploading in the UI). The capability never reaches JavaScript.
  server.post("/viewer/bootstrap", guard(async (c) => {
    assertAllowedOrigin(ctx, c);
    const r = await createClient(ctx, sourceOf(c), "browser");
    const s = signSession(ctx, r.client_id);
    setSessionCookie(ctx, c, s.value, s.maxAge);
    return c.json({ ok: true, client_id: r.client_id, expires_at: r.expires_at }, 201, nostore);
  }));

  // demo_buyer tells the dashboard whether to offer the in-browser demo agent (test-mode deployments only).
  server.get("/viewer/me", async (c) => {
    const demo_buyer = ctx.cfg.demoBuyer.enabled;
    try {
      const a = await authenticate(ctx, c);
      return c.json({ authenticated: true, client_id: a.id, demo_buyer }, 200, nostore);
    } catch { return c.json({ authenticated: false, demo_buyer }, 200, nostore); }
  });

  // Server-side demo agent pays this browser session's own quote through the real MPP flow (test mode only).
  // The body is ignored: the job comes from the path and the terms from the stored quote.
  server.post("/viewer/jobs/:job_id/demo-purchase", async (c) => {
    const jobId = c.req.param("job_id");
    try {
      if (c.req.header("x-mediapack-token") !== undefined) {
        throw new AppError("UNAUTHORIZED", "The demo buyer requires a signed browser session; owner-token requests are not accepted.");
      }
      const a = await authenticate(ctx, c);
      return c.json(await demoPurchase(ctx, a.id, jobId), 200, nostore);
    } catch (e) { return errorResponse(c, e, jobId); }
  });

  server.post("/viewer/logout", guard(async (c) => {
    assertAllowedOrigin(ctx, c);
    clearSessionCookie(c);
    return c.json({ ok: true }, 200, nostore);
  }));
}
