// Bounded outbox dispatch. DB leases rows (no network inside the txn); Primitive send happens after.
import { background, type Ctx } from "./ctx.js";

export interface DispatchResult { claimed: number; sent: number; failed: number }

export async function dispatchOutbox(ctx: Ctx, limit = 10): Promise<DispatchResult> {
  const rows = await ctx.sql`select * from claim_outbox_batch(${limit}, 60)`;
  let sent = 0, failed = 0;
  await Promise.all(rows.map(async (row) => {
    try {
      if (row.target !== "primitive") throw new Error(`unsupported outbox target ${row.target}`);
      const payload = row.payload as { operation_id: string; generation: number; action: string };
      const res = await ctx.primitive.send({
        subject: `[mp:${payload.operation_id}:g${payload.generation}] ${payload.action}`,
        bodyText: JSON.stringify(row.payload),
        idempotencyKey: row.idempotency_key,
      });
      await ctx.sql`select mark_outbox_sent(${row.id}::uuid, ${res.id})`;
      sent++;
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[outbox] send failed for ${row.logical_key}: ${msg}`);
      await ctx.sql`select mark_outbox_failed(${row.id}::uuid, ${msg})`.catch(() => {});
    }
  }));
  return { claimed: rows.length, sent, failed };
}

/** Fire-and-forget dispatch right after a commit; the scheduled /internal/tick recovers anything missed. */
export function kickOutbox(ctx: Ctx): void {
  background(ctx, Promise.race([
    dispatchOutbox(ctx),
    new Promise((_, rej) => setTimeout(() => rej(new Error("outbox kick timed out")), 20_000).unref()),
  ]), "outbox");
}
