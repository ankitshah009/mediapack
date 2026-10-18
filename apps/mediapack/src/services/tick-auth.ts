import { createHmac } from "node:crypto";
import { requireTickToken } from "../config.js";
import { safeEqual } from "./crypto.js";
import type { Ctx } from "./ctx.js";
import { AppError } from "./errors.js";

export function verifyTickSignature(secret: string, headers: {
  timestamp?: string; nonce?: string; signature?: string;
}, nowMs = Date.now()): { nonce: string; timestamp: number } | undefined {
  const { timestamp, nonce, signature } = headers;
  if (!timestamp || !/^(0|[1-9]\d{0,11})$/.test(timestamp) ||
      !nonce || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(nonce) ||
      !signature || !/^[0-9a-f]{64}$/.test(signature)) return;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || Math.abs(Math.floor(nowMs / 1000) - seconds) > 90) return;
  const expected = createHmac("sha256", secret).update(`mediapack-tick-v1\n${timestamp}\n${nonce}`).digest("hex");
  if (!safeEqual(signature, expected)) return;
  return { nonce, timestamp: seconds };
}

/** pg_net queues expose request headers, so scheduled calls use one-time signatures. */
export async function authorizeRecoveryTick(ctx: Ctx, headers: Headers, nowMs = Date.now()): Promise<void> {
  const authorization = headers.get("authorization");
  const bearer = authorization && /^bearer\s+/i.test(authorization) ? authorization.replace(/^bearer\s+/i, "").trim() : undefined;
  const supplied = {
    timestamp: headers.get("x-mediapack-tick-timestamp") ?? undefined,
    nonce: headers.get("x-mediapack-tick-nonce") ?? undefined,
    signature: headers.get("x-mediapack-tick-signature") ?? undefined,
  };
  if (!bearer && !supplied.signature) throw new AppError("UNAUTHORIZED", "Invalid tick credential.");
  const secret = requireTickToken(ctx.cfg);
  if (bearer && safeEqual(bearer, secret)) return;
  const claims = verifyTickSignature(secret, supplied, nowMs);
  if (!claims) throw new AppError("UNAUTHORIZED", "Invalid or expired tick signature.");
  try {
    const claimed = await ctx.sql.begin(async tx => {
      await tx`delete from mediapack_setup.recovery_nonces where expires_at < now()`;
      return tx`insert into mediapack_setup.recovery_nonces (nonce, expires_at)
        values (${claims.nonce}::uuid, now() + interval '300 seconds')
        on conflict (nonce) do nothing returning nonce`;
    });
    if (!claimed.length) throw new AppError("UNAUTHORIZED", "Tick signature has already been used.");
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("INTERNAL", "Recovery signature storage is unavailable. Run the recovery scheduler setup before sending signed ticks.", { status: 503 });
  }
}
