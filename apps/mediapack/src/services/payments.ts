// Purchase state gate, verified-payment application, Stripe webhook recovery, reconciliation.
import type Stripe from "stripe";
import { PurchaseRequest } from "../contracts/index.js";
import { requireStripe } from "../config.js";
import { AppError } from "./errors.js";
import { sha256 } from "./crypto.js";
import type { Ctx } from "./ctx.js";
import { kickOutbox } from "./outbox.js";
import { loadJob, purchaseInstructions, quoteView } from "./views.js";

type Row = Record<string, any>;
class PaymentInvalid extends Error {}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

function receiptBody(ctx: Ctx, job: Row, extra: Row = {}) {
  const q = job.quote;
  return {
    job_id: job.id,
    quote_id: q.id,
    payment_state: "paid",
    receipt: {
      method: "stripe", reference: job.payment_intent_id, status: "success", amount_minor: q.amount_minor, currency: q.currency,
      mode: q.payment_mode, paid_at: job.paid_at ? new Date(job.paid_at).toISOString() : null,
    },
    status_url: `${ctx.cfg.publicOrigin}/v1/jobs/${job.id}`,
    next_action: "Indexing starts now; poll get_job until state is ready.",
    ...extra,
  };
}

const reconcilingResponse = (ctx: Ctx, jobId: string) =>
  json({
    payment_state: "reconciling",
    job_id: jobId,
    status_url: `${ctx.cfg.publicOrigin}/v1/jobs/${jobId}`,
    retry_after_seconds: 5,
    error: { code: "PAYMENT_RECONCILING", message: "The purchase outcome is being checked.", retryable: true, retry_after_seconds: 5, job_id: jobId, next_action: "get_job" },
  }, 202, { "retry-after": "5" });

function validatePaymentIntent(ctx: Ctx, pi: Stripe.PaymentIntent, job: Row, expectedAttempt?: string | null) {
  const q = job.quote;
  const md = pi.metadata ?? {};
  if (pi.status !== "succeeded") throw new PaymentInvalid(`status ${pi.status}`);
  if (pi.amount !== q.amount_minor) throw new PaymentInvalid("amount mismatch");
  if (String(pi.currency).toLowerCase() !== q.currency) throw new PaymentInvalid("currency mismatch");
  if (pi.livemode !== ctx.stripe.livemode) throw new PaymentInvalid("livemode mismatch");
  if (q.payment_mode === "test" && pi.livemode) throw new PaymentInvalid("live payment for a test quote");
  if (md.job_id !== job.id || md.quote_id !== q.id || md.terms_hash !== q.terms_hash) throw new PaymentInvalid("metadata mismatch");
  if (expectedAttempt && md.attempt_id !== expectedAttempt) throw new PaymentInvalid("attempt mismatch");
}

async function applyPayment(ctx: Ctx, job: Row, pi: Stripe.PaymentIntent, attemptId: string | null) {
  const [r] = await ctx.sql`
    select * from apply_verified_payment(${job.id}::uuid, ${attemptId}::uuid, ${pi.id}, ${pi.amount}, ${pi.currency}, ${pi.livemode})`;
  if (r!.outcome === "applied") kickOutbox(ctx);
  return r!.outcome as "applied" | "already_applied";
}

async function settle(ctx: Ctx, attemptId: string, state: "unknown" | "failed", errorClass: string, pi?: string) {
  await ctx.sql`select settle_payment_attempt(${attemptId}::uuid, ${state}, ${errorClass}, ${pi ?? null})`.catch((e) => console.error("[payments] settle failed", e.message));
}

const DECLINE = /card was declined|card_declined|insufficient[_ ]funds|expired[_ ]card|incorrect[_ ]cvc|do not honor|your card/i;

export async function purchase(ctx: Ctx, clientId: string, jobId: string, request: Request): Promise<Response> {
  const raw = await request.text();
  let body;
  try { body = PurchaseRequest.parse(JSON.parse(raw)); } catch { throw new AppError("BAD_REQUEST", 'Body must be {"quote_id":"<uuid>"}.'); }
  const job = await loadJob(ctx, clientId, jobId);
  if (job.quote_id !== body.quote_id) throw new AppError("BAD_REQUEST", "quote_id does not belong to this job.", { jobId });
  const idem = request.headers.get("idempotency-key");
  if (idem && idem.length > 255) throw new AppError("BAD_REQUEST", "Idempotency-Key is too long.");

  if (job.paid_at) return json(receiptBody(ctx, job));
  const [live] = await ctx.sql`select 1 from payment_attempts where job_id = ${jobId}::uuid and state in ('submitting','unknown') limit 1`;
  if (live) return reconcilingResponse(ctx, jobId);
  if (new Date(job.quote.expires_at) < new Date()) {
    throw new AppError("QUOTE_EXPIRED", "The quote expired; request a new one.", { jobId, nextAction: "quote_video" });
  }
  if (job.state !== "awaiting_payment") throw new AppError("PAYMENT_REQUIRED", `Job is ${job.state}.`, { jobId });
  requireStripe(ctx.cfg);

  const q = job.quote;
  const attempt: { id?: string } = {};
  const binding = {
    amountMinor: q.amount_minor, currency: q.currency, quoteId: q.id, jobId, termsHash: q.terms_hash,
    route: `POST /v1/jobs/${jobId}/purchase`,
    intentMetadata: () => ({ job_id: jobId, quote_id: q.id, terms_hash: q.terms_hash, attempt_id: attempt.id ?? "" }),
  };
  const mkRequest = () => new Request(request.url, { method: "POST", headers: request.headers, body: raw });
  const auth = request.headers.get("authorization") ?? "";

  if (!/^payment\s/i.test(auth)) {
    const out = await ctx.stripe.charge(mkRequest(), binding);
    if (out.status === 402) return out.response; // MPP challenge for the stored terms
    throw new AppError("INTERNAL", "Unexpected payment state.");
  }

  const fingerprint = sha256(auth).slice(0, 32);
  const [res] = await ctx.sql`select * from reserve_payment_attempt(${clientId}::uuid, ${jobId}::uuid, ${q.terms_hash}, ${fingerprint})`;
  if (res!.outcome === "paid") return json(receiptBody(ctx, await loadJob(ctx, clientId, jobId)));
  if (res!.outcome === "reconciling") return reconcilingResponse(ctx, jobId);
  if (res!.outcome === "expired") throw new AppError("QUOTE_EXPIRED", "The quote expired; request a new one.", { jobId, nextAction: "quote_video" });
  attempt.id = res!.attempt_id as string;

  let out;
  try {
    out = await ctx.stripe.charge(mkRequest(), binding);
  } catch (e) {
    console.error("[payments] charge threw", e instanceof Error ? e.message : e);
    await settle(ctx, attempt.id, "unknown", "charge_exception");
    return reconcilingResponse(ctx, jobId);
  }

  if (out.status === 402) {
    if (!out.reachedStripe) { // rejected before any PaymentIntent was attempted: definitive, safe to retry with a fresh challenge
      await settle(ctx, attempt.id, "failed", "credential_rejected");
      return out.response;
    }
    const text = await out.response.clone().text().catch(() => "");
    if (DECLINE.test(text)) {
      await settle(ctx, attempt.id, "failed", "declined");
      return out.response;
    }
    await settle(ctx, attempt.id, "unknown", "ambiguous_after_submit"); // a transport error does not prove a failed charge
    return reconcilingResponse(ctx, jobId);
  }

  // Success from the SDK: trust only the retrieved PaymentIntent.
  try {
    const pi = await ctx.stripe.retrievePaymentIntent(out.reference);
    validatePaymentIntent(ctx, pi, job, attempt.id);
    await applyPayment(ctx, job, pi, attempt.id);
  } catch (e) {
    const cls = e instanceof PaymentInvalid ? `validation:${e.message}` : "apply_failed";
    console.error(`[payments] job ${jobId} charged (${out.reference}) but not applied: ${cls}`);
    await settle(ctx, attempt.id, "unknown", cls, out.reference);
    return reconcilingResponse(ctx, jobId);
  }
  const paid = await loadJob(ctx, clientId, jobId);
  return out.withReceipt(json(receiptBody(ctx, paid)));
}

// ───────────────────────── Stripe webhook ─────────────────────────

export async function handleStripeWebhook(ctx: Ctx, raw: string, signature: string | undefined): Promise<Response> {
  let event: Stripe.Event;
  try { event = ctx.stripe.constructEvent(raw, signature); }
  catch (e) {
    if (e instanceof AppError) throw e;
    return json({ error: { code: "UNAUTHORIZED", message: "Invalid Stripe signature.", retryable: false } }, 400);
  }
  const pi0 = event.type.startsWith("payment_intent.") ? (event.data.object as Stripe.PaymentIntent) : undefined;
  const summary = { payment_intent_id: pi0?.id ?? null, job_id: pi0?.metadata?.job_id ?? null, quote_id: pi0?.metadata?.quote_id ?? null };
  const ins = await ctx.sql`
    insert into provider_events (provider, event_id, kind, payload) values ('stripe', ${event.id}, ${event.type}, ${ctx.sql.json(summary)})
    on conflict do nothing returning event_id`;
  if (!ins.length) {
    const [ex] = await ctx.sql`select state from provider_events where provider = 'stripe' and event_id = ${event.id}`;
    if (ex && (ex.state === "applied" || ex.state === "ignored")) return json({ received: true, duplicate: true });
  }
  const mark = (state: string, error?: string) => ctx.sql`update provider_events set state = ${state}, error = ${error ?? null}, applied_at = case when ${state} = 'applied' then now() else applied_at end where provider = 'stripe' and event_id = ${event.id}`;

  if (event.type !== "payment_intent.succeeded" || !pi0?.metadata?.job_id || !pi0.metadata.quote_id) {
    await mark("ignored");
    return json({ received: true, ignored: true });
  }
  try {
    const [j] = await ctx.sql`select client_id from jobs where id = ${pi0.metadata.job_id}::uuid`.catch(() => []);
    if (!j) { await mark("ignored", "unknown job"); return json({ received: true, ignored: true }); }
    const job = await loadJob(ctx, j.client_id, pi0.metadata.job_id);
    const pi = await ctx.stripe.retrievePaymentIntent(pi0.id);
    validatePaymentIntent(ctx, pi, job);
    await applyPayment(ctx, job, pi, null);
    await mark("applied");
    return json({ received: true });
  } catch (e) {
    if (e instanceof PaymentInvalid || (e instanceof Error && /JOB_PAID_BY_OTHER_PAYMENT|PAYMENT_MISMATCH/.test(e.message))) {
      console.error(`[stripe-webhook] event ${event.id} not applied: ${(e as Error).message} (manual review/refund may be needed)`);
      await mark("error", (e as Error).message.slice(0, 200));
      return json({ received: true, applied: false });
    }
    await mark("error", e instanceof Error ? e.message.slice(0, 200) : "error");
    throw e; // transient: non-2xx so Stripe retries
  }
}

// ───────────────────────── reconciliation (called from /internal/tick) ─────────────────────────

export async function reconcilePayments(ctx: Ctx): Promise<{ checked: number; applied: number; failed: number }> {
  const rows = await ctx.sql`
    select pa.id, pa.job_id, pa.payment_intent_id, j.client_id from payment_attempts pa join jobs j on j.id = pa.job_id
    where pa.state in ('submitting','unknown') and pa.updated_at < now() - interval '60 seconds' order by pa.updated_at limit 20`;
  let applied = 0, failed = 0;
  for (const a of rows) {
    try {
      let pi: Stripe.PaymentIntent | undefined;
      if (a.payment_intent_id) pi = await ctx.stripe.retrievePaymentIntent(a.payment_intent_id);
      else {
        const found = await ctx.stripe.searchPaymentIntentsByAttempt(a.id);
        pi = found.find((p) => p.status === "succeeded") ?? found[0];
      }
      if (!pi) continue; // search is eventually consistent: empty is not evidence of no payment
      if (pi.status === "succeeded") {
        const job = await loadJob(ctx, a.client_id, a.job_id);
        validatePaymentIntent(ctx, pi, job, a.id);
        await applyPayment(ctx, job, pi, a.id);
        applied++;
      } else if (pi.status === "canceled" || pi.status === "requires_payment_method") {
        await settle(ctx, a.id, "failed", `stripe:${pi.status}`, pi.id);
        failed++;
      }
    } catch (e) {
      console.error(`[reconcile] attempt ${a.id}:`, e instanceof Error ? e.message : e);
    }
  }
  return { checked: rows.length, applied, failed };
}

export { quoteView, purchaseInstructions };
