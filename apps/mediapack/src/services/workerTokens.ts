// Short-lived worker credentials: HMAC over {op, gen, video_id, prefix, exp}. Never authorize purchase or other operations.
import { createHmac } from "node:crypto";
import { requireWorkerTokenSecret } from "../config.js";
import { AppError } from "./errors.js";
import { b64url, safeEqual } from "./crypto.js";
import type { Ctx } from "./ctx.js";

export interface WorkerClaims { op: string; gen: number; video_id: string; prefix: string; exp: number }

export const opPrefix = (videoId: string, op: string, gen: number) => `${videoId}/ops/${op}/g${gen}/`;

export function signWorkerToken(ctx: Ctx, c: Omit<WorkerClaims, "prefix" | "exp"> & { ttlSeconds?: number }): string {
  const claims: WorkerClaims = {
    op: c.op, gen: c.gen, video_id: c.video_id,
    prefix: opPrefix(c.video_id, c.op, c.gen),
    exp: Math.floor(Date.now() / 1000) + (c.ttlSeconds ?? ctx.cfg.workerTokenTtlSeconds),
  };
  const body = b64url(JSON.stringify(claims));
  const sig = createHmac("sha256", requireWorkerTokenSecret(ctx.cfg)).update(`wt1.${body}`).digest("base64url");
  return `wt1.${body}.${sig}`;
}

export function verifyWorkerToken(ctx: Ctx, token: string | undefined): WorkerClaims {
  const bad = () => new AppError("UNAUTHORIZED", "Invalid or expired worker token.");
  if (!token) throw bad();
  const [v, body, sig] = token.split(".");
  if (v !== "wt1" || !body || !sig) throw bad();
  const expect = createHmac("sha256", requireWorkerTokenSecret(ctx.cfg)).update(`wt1.${body}`).digest("base64url");
  if (!safeEqual(sig, expect)) throw bad();
  let c: WorkerClaims;
  try { c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { throw bad(); }
  if (c.exp < Date.now() / 1000 || c.prefix !== opPrefix(c.video_id, c.op, c.gen)) throw bad();
  return c;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,120}$/;

export async function artifactAccess(
  ctx: Ctx, claims: WorkerClaims,
  body: { uploads?: { name: string; content_type: string }[]; downloads?: ("source" | "index")[] },
) {
  // The token's generation must still be the operation's current generation, and the op not finished.
  const [op] = await ctx.sql`select id, job_id, video_id, generation, state from operations where id = ${claims.op}::uuid`;
  if (!op || op.generation !== claims.gen || op.video_id !== claims.video_id || op.state === "succeeded" || op.state === "failed") {
    throw new AppError("UNAUTHORIZED", "Worker token no longer valid for this operation.");
  }
  const uploads = [];
  for (const u of body.uploads ?? []) {
    if (!NAME.test(u.name) || u.name.includes("..") || u.name.includes("//") || u.name.endsWith("/")) {
      throw new AppError("BAD_REQUEST", `Invalid artifact name: ${u.name.slice(0, 60)}`);
    }
    const object_key = claims.prefix + u.name;
    const up = await ctx.storage.createUpload(object_key, u.content_type);
    uploads.push({ name: u.name, object_key, method: up.method, url: up.url, headers: up.headers });
  }
  const downloads: { source?: string; index?: string } = {};
  const ttl = 3600;
  for (const d of new Set(body.downloads ?? [])) {
    if (d === "source") {
      const [v] = await ctx.sql`select object_key from videos where id = ${claims.video_id}::uuid`;
      downloads.source = await ctx.storage.createDownloadUrl(v!.object_key, ttl);
    } else if (d === "index") {
      if (!op.job_id) throw new AppError("INDEX_NOT_READY", "No index for a preflight operation.");
      const [a] = await ctx.sql`
        select a.object_key from jobs j join artifacts a on a.id = j.index_artifact_id where j.id = ${op.job_id}::uuid`;
      if (!a) throw new AppError("INDEX_NOT_READY", "The index artifact is not available yet.", { retryAfter: 5 });
      downloads.index = await ctx.storage.createDownloadUrl(a.object_key, ttl);
    }
  }
  return { uploads, downloads };
}
