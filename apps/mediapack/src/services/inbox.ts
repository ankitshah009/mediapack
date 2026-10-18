// Primitive webhook: verify -> durable provider_events insert (unique constraint dedupe) -> branch.
//   work_request mail to worker@ -> claim_operation + launch the Blaxel process
//   work_result reply to control@ -> validate + apply
import { WorkRequest, WorkResult, hashCanonical } from "../contracts/index.js";
import { InboundEmailEvent, bareAddress, extractJson } from "../adapters/primitive.js";
import { background, type Ctx } from "./ctx.js";
import { kickOutbox } from "./outbox.js";
import { applyWorkResult } from "./operations.js";
import { signWorkerToken } from "./workerTokens.js";

/** Readable, bounded text for a launch failure; provider SDKs sometimes throw plain objects. */
export function launchErrorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    const m = [o.message, o.error, o.detail, o.code].find((v) => typeof v === "string" && v.trim());
    if (typeof m === "string") return m.slice(0, 300);
    try { return JSON.stringify(e).slice(0, 300); } catch { /* fall through */ }
  }
  return "unknown provider error";
}

const SOFT_DEADLINE_MS = 8000;
const SUBJECT = /^\s*(?:re:\s*)?\[mp:([0-9a-f-]{36}):g(\d+)\]/i;

interface StoredMail {
  subject: string; from: string; to: string; rcpt_to: string[]; message_id: string | null; in_reply_to: string[];
  body_text: string; dmarc: string | null; email_id: string; attempts?: number;
}
type Processed = { state: "applied" | "ignored"; detail: string };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function handlePrimitiveWebhook(ctx: Ctx, raw: Buffer, signature: string | undefined): Promise<Response> {
  try { ctx.primitive.verifyWebhook(raw, signature); }
  catch (e) {
    if (e instanceof Error && (e as { status?: number }).status === 503) throw e;
    if (e instanceof Error && /not configured/.test(e.message)) throw e;
    return json({ error: { code: "UNAUTHORIZED", message: "Invalid Primitive signature.", retryable: false } }, 401);
  }
  let body: unknown;
  try { body = JSON.parse(raw.toString("utf8")); } catch { return json({ error: { code: "BAD_REQUEST", message: "Invalid JSON.", retryable: false } }, 400); }

  const parsed = InboundEmailEvent.safeParse(body);
  if (!parsed.success) {
    const b = body as { id?: unknown; event?: unknown };
    if (typeof b?.id === "string") { // some other verified event type: record it so it is not retried forever
      await ctx.sql`insert into provider_events (provider, event_id, kind, state) values ('primitive', ${b.id}, ${String(b.event ?? "unknown")}, 'ignored') on conflict do nothing`;
    }
    return json({ received: true, ignored: true });
  }
  const ev = parsed.data;
  const dmarc = (ev.email.auth as { dmarc?: string } | undefined)?.dmarc ?? null;
  const mail: StoredMail = {
    subject: ev.email.headers.subject ?? "", from: ev.email.headers.from, to: ev.email.headers.to,
    rcpt_to: ev.email.smtp?.rcpt_to ?? [], message_id: ev.email.headers.message_id ?? null,
    in_reply_to: ev.email.parsed?.in_reply_to ?? [], body_text: (ev.email.parsed?.body_text ?? "").slice(0, 262_144),
    dmarc, email_id: ev.email.id,
  };
  // Persist BEFORE 2xx. A failure here propagates as 500 so Primitive redelivers.
  const ins = await ctx.sql`
    insert into provider_events (provider, event_id, kind, email_id, thread_id, payload)
    values ('primitive', ${ev.id}, ${ev.event}, ${ev.email.id}, ${ev.email.thread_id ?? null}, ${ctx.sql.json(mail as never)})
    on conflict do nothing returning event_id`;
  if (!ins.length) {
    const [ex] = await ctx.sql`select state from provider_events where provider = 'primitive' and event_id = ${ev.id}`;
    if (ex && (ex.state === "applied" || ex.state === "ignored")) return json({ received: true, duplicate: true });
  }
  if (ev.event !== "email.received") {
    await ctx.sql`update provider_events set state = 'ignored' where provider = 'primitive' and event_id = ${ev.id}`;
    return json({ received: true, ignored: true });
  }

  const work = processAndMark(ctx, ev.id, mail);
  background(ctx, work, "primitive-event");
  const first = await Promise.race([work, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), SOFT_DEADLINE_MS).unref())]);
  if (first === "timeout") return json({ received: true, processing: "background" });
  if (!first.ok) return json({ error: { code: "INTERNAL", message: "Processing failed; retry.", retryable: true } }, 500);
  return json({ received: true, state: first.state, detail: first.detail });
}

async function processAndMark(ctx: Ctx, eventId: string, mail: StoredMail): Promise<{ ok: true; state: string; detail: string } | { ok: false }> {
  try {
    const r = await processMail(ctx, mail);
    await ctx.sql`update provider_events set state = ${r.state}, error = ${r.state === "ignored" ? r.detail : null}, applied_at = case when ${r.state} = 'applied' then now() else applied_at end
                  where provider = 'primitive' and event_id = ${eventId}`;
    return { ok: true, ...r };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[primitive-event ${eventId}] ${msg}`);
    await ctx.sql`update provider_events set state = 'error', error = ${msg.slice(0, 300)},
                    payload = payload || jsonb_build_object('attempts', coalesce((payload->>'attempts')::int, 0) + 1)
                  where provider = 'primitive' and event_id = ${eventId}`.catch(() => {});
    return { ok: false };
  }
}

async function processMail(ctx: Ctx, mail: StoredMail): Promise<Processed> {
  const ignored = (detail: string): Processed => ({ state: "ignored", detail });
  const control = ctx.primitive.controlAddress.toLowerCase();
  const worker = ctx.primitive.workerAddress.toLowerCase();
  const from = bareAddress(mail.from);
  const recipients = [...mail.rcpt_to, mail.to].map(bareAddress);
  const subj = SUBJECT.exec(mail.subject);
  if (!subj) return ignored("subject is not a MediaPack envelope");
  const body = extractJson(mail.body_text) as { kind?: string } | undefined;
  if (!body || typeof body !== "object") return ignored("no JSON body");

  if (body.kind === "work_request") {
    if (!recipients.includes(worker) || from !== control) return ignored("work_request not control->worker");
    return launchFromRequest(ctx, mail, body, subj[1]!.toLowerCase(), Number(subj[2]));
  }
  if (body.kind === "work_result") {
    if (!recipients.includes(control) || from !== worker) return ignored("work_result not worker->control");
    if (ctx.cfg.requireSenderAuth && mail.dmarc !== "pass") return ignored("sender authentication failed");
    const wr = WorkResult.safeParse(body);
    if (!wr.success) return ignored("malformed work_result");
    if (wr.data.operation_id.toLowerCase() !== subj[1]!.toLowerCase() || wr.data.generation !== Number(subj[2])) return ignored("subject/body mismatch");
    const r = await applyWorkResult(ctx, wr.data);
    return { state: r.outcome === "ignored" ? "ignored" : "applied", detail: `${r.outcome}${r.detail ? `: ${r.detail}` : ""}` };
  }
  return ignored("unknown envelope kind");
}

async function launchFromRequest(ctx: Ctx, mail: StoredMail, body: unknown, opId: string, gen: number): Promise<Processed> {
  const claimed = WorkRequest.safeParse(body);
  if (!claimed.success || claimed.data.operation_id.toLowerCase() !== opId || claimed.data.generation !== gen) return { state: "ignored", detail: "malformed work_request" };
  // The authoritative request is the one control persisted; a forged mail to worker@ cannot launch anything else.
  const [ob] = await ctx.sql`select payload from outbox where logical_key = ${`mp:${opId}:request:${gen}`}`;
  if (!ob || hashCanonical(WorkRequest.parse(ob.payload)) !== hashCanonical(claimed.data)) return { state: "ignored", detail: "work_request does not match the stored outbox payload" };
  const wr = WorkRequest.parse(ob.payload);
  const [op] = await ctx.sql`select id, kind, generation, video_id from operations where id = ${opId}::uuid`;
  if (!op || op.generation !== gen || op.kind !== wr.action) return { state: "ignored", detail: "operation generation/kind mismatch" };

  const provisional = `mp-${opId.slice(0, 8)}-g${gen}`;
  const [c] = await ctx.sql`select claim_operation(${opId}::uuid, ${gen}, ${provisional}, ${provisional}, ${ctx.cfg.workerLeaseSeconds}) as ok`;
  if (!c!.ok) return { state: "applied", detail: "already claimed or finished (duplicate delivery)" };
  try {
    const launched = await ctx.launchWorker({
      work_request: wr,
      reply_email_id: mail.email_id,
      worker_token: signWorkerToken(ctx, { op: opId, gen, video_id: op.video_id }),
      control_base_url: ctx.cfg.publicOrigin,
    });
    const recorded = await ctx.sql.begin(async (tx) => {
      const [current] = await tx`
        update operations set sandbox_name = ${launched.sandboxName}, process_name = ${launched.processName}
        where id = ${opId}::uuid and generation = ${gen}
        returning video_id, job_id, kind`;
      if (!current) return false;
      await tx`select app_event(${current.video_id}::uuid, ${current.job_id}::uuid, ${opId}::uuid, 'worker.launched',
        ${tx.json({ kind: current.kind, sandbox: launched.sandboxName, process: launched.processName, generation: gen })})`;
      return true;
    });
    return { state: "applied", detail: recorded ? `launched ${launched.sandboxName}` : "launch returned after its generation was superseded" };
  } catch (e) {
    const msg = launchErrorText(e);
    console.error(`[launch ${opId}] failed: ${msg}`);
    await ctx.sql`select fail_or_retry_operation(${opId}::uuid, ${gen}, 'WORKER_FAILED', ${"worker launch failed: " + msg}, true)`;
    kickOutbox(ctx);
    return { state: "applied", detail: "launch failed; operation retried or failed" };
  }
}

/** Re-run events that were persisted but not completed (called from /internal/tick). */
export async function reprocessPendingEvents(ctx: Ctx): Promise<number> {
  const rows = await ctx.sql`
    select event_id, payload from provider_events
    where provider = 'primitive' and kind = 'email.received' and state in ('received','error')
      and received_at < now() - interval '30 seconds' and coalesce((payload->>'attempts')::int, 0) < 5
    order by received_at limit 10`;
  for (const r of rows) await processAndMark(ctx, r.event_id, r.payload as StoredMail);
  return rows.length;
}
