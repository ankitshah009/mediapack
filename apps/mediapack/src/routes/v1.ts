import type { RouteHost } from "./http.js";
import { ClipRequest, CompleteUploadRequest, CreateVideoRequest, FramesRequest, QuoteRequest, SearchRequest } from "../contracts/index.js";
import { z } from "zod";
import { authenticate, errorResponse, guard, readBody, sourceOf } from "./http.js";
import { createClient, createViewerCode } from "../services/clients.js";
import { completeUpload, createVideo, quoteVideo } from "../services/videos.js";
import { artifactAccessForClient, getOperation, getPack, requestClip, requestFrames, requestSearch } from "../services/operations.js";
import { purchase } from "../services/payments.js";
import { getEvents, getJobView, getVideoView, listVideoViews } from "../services/views.js";
import type { Ctx } from "../services/ctx.js";

import type { Context } from "hono";
const P = (c: Context, k: string) => c.req.param(k) as string;
const nostore = { "cache-control": "no-store" };

export function registerV1(server: RouteHost, ctx: Ctx) {
  server.post("/v1/clients", guard(async (c) => {
    let name: string | undefined;
    try { const b = await c.req.json(); name = z.object({ display_name: z.string().max(80).optional() }).parse(b).display_name; } catch { /* body optional */ }
    const r = await createClient(ctx, sourceOf(c), name);
    return c.json({ ...r, header: "X-MediaPack-Token", note: "Store this capability securely; it is shown once." }, 201, nostore);
  }));

  server.post("/v1/clients/viewer-code", guard(async (c) => {
    const a = await authenticate(ctx, c);
    return c.json(await createViewerCode(ctx, a.id), 201, nostore);
  }));

  // ── videos ──
  server.post("/v1/videos", guard(async (c) => {
    const a = await authenticate(ctx, c);
    const { created, body } = await createVideo(ctx, a.id, await readBody(c, CreateVideoRequest));
    return c.json(body, created ? 201 : 200, nostore);
  }));
  server.get("/v1/videos", guard(async (c) => {
    const a = await authenticate(ctx, c);
    return c.json({ videos: await listVideoViews(ctx, a.id) }, 200, nostore);
  }));
  server.get("/v1/videos/:video_id", guard(async (c) => {
    const a = await authenticate(ctx, c);
    return c.json(await getVideoView(ctx, a.id, P(c, "video_id")), 200, nostore);
  }));
  server.post("/v1/videos/:video_id/complete", guard(async (c) => {
    const a = await authenticate(ctx, c);
    await readBody(c, CompleteUploadRequest).catch(() => undefined); // request_id is accepted; completion is idempotent per video
    const r = await completeUpload(ctx, a.id, P(c, "video_id"));
    return c.json(r, r.video.state === "probing" ? 202 : 200, nostore);
  }));
  server.post("/v1/videos/:video_id/quotes", guard(async (c) => {
    const a = await authenticate(ctx, c);
    await readBody(c, QuoteRequest).catch(() => undefined);
    const { quote, created } = await quoteVideo(ctx, a.id, P(c, "video_id"));
    return c.json(quote, created ? 201 : 200, nostore);
  }));

  // ── jobs ──
  server.get("/v1/jobs/:job_id", guard(async (c) => {
    const a = await authenticate(ctx, c);
    return c.json(await getJobView(ctx, a.id, P(c, "job_id")), 200, nostore);
  }));
  server.post("/v1/jobs/:job_id/purchase", async (c) => {
    try {
      const a = await authenticate(ctx, c);
      return await purchase(ctx, a.id, P(c, "job_id"), c.req.raw);
    } catch (e) { return errorResponse(c, e, P(c, "job_id")); }
  });
  const opRoute = (path: string, schema: z.ZodType<any>, fn: (clientId: string, jobId: string, body: any) => Promise<{ status: 200 | 202; operation: unknown }>) =>
    server.post(path, async (c) => {
      const jobId = P(c, "job_id");
      try {
        const a = await authenticate(ctx, c);
        const r = await fn(a.id, jobId, await readBody(c, schema));
        return c.json(r.operation as never, r.status, r.status === 202 ? { ...nostore, "retry-after": "5" } : nostore);
      } catch (e) { return errorResponse(c, e, jobId); }
    });
  opRoute("/v1/jobs/:job_id/searches", SearchRequest, (cl, j, b) => requestSearch(ctx, cl, j, b));
  opRoute("/v1/jobs/:job_id/frames", FramesRequest, (cl, j, b) => requestFrames(ctx, cl, j, b));
  opRoute("/v1/jobs/:job_id/clips", ClipRequest, (cl, j, b) => requestClip(ctx, cl, j, b));

  server.get("/v1/jobs/:job_id/operations/:operation_id", guard(async (c) => {
    const a = await authenticate(ctx, c);
    return c.json(await getOperation(ctx, a.id, P(c, "job_id"), P(c, "operation_id")), 200, nostore);
  }));
  server.get("/v1/jobs/:job_id/pack", guard(async (c) => {
    const a = await authenticate(ctx, c);
    return c.json(await getPack(ctx, a.id, P(c, "job_id")), 200, nostore);
  }));
  server.get("/v1/jobs/:job_id/events", guard(async (c) => {
    const a = await authenticate(ctx, c);
    const after = Math.max(0, Number(c.req.query("after") ?? 0) || 0);
    return c.json(await getEvents(ctx, a.id, P(c, "job_id"), after), 200, nostore);
  }));

  server.get("/v1/artifacts/:artifact_id/access", guard(async (c) => {
    const a = await authenticate(ctx, c);
    const r = await artifactAccessForClient(ctx, a.id, P(c, "artifact_id"));
    return c.json(r, 200, nostore);
  }));
}
