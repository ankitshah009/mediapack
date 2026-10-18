import type { RouteHost } from "./http.js";
import { z } from "zod";
import { assertAllowedOrigin, authenticate, clearSessionCookie, guard, readBody, setSessionCookie, sourceOf } from "./http.js";
import { consumeViewerCode, createClient, signSession } from "../services/clients.js";
import type { Ctx } from "../services/ctx.js";

const nostore = { "cache-control": "no-store" };

export function registerViewer(server: RouteHost, ctx: Ctx) {
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

  server.get("/viewer/me", async (c) => {
    try {
      const a = await authenticate(ctx, c);
      return c.json({ authenticated: true, client_id: a.id }, 200, nostore);
    } catch { return c.json({ authenticated: false }, 200, nostore); }
  });

  server.post("/viewer/logout", guard(async (c) => {
    assertAllowedOrigin(ctx, c);
    clearSessionCookie(c);
    return c.json({ ok: true }, 200, nostore);
  }));
}
