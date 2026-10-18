// In-browser "demo agent". It pays a browser session's own quote by running the exact Machine Payments Protocol
// (HTTP 402) flow the CLI buyer runs (scripts/mediapack.mjs buy): mppx's client probes the purchase endpoint, receives
// the signed challenge, mints a Stripe sandbox shared payment token and retries with the credential. Only the transport
// differs: the client's fetch calls purchase() in-process, so the same idempotent, SQL-enforced payment gate
// (reserve_payment_attempt, apply_verified_payment) decides the outcome. Nothing is simulated.
// Test mode only: config.demoBuyer.enabled is the single gate and is never true for live keys.
import { requireStripe } from "../config.js";
import type { JobView } from "../contracts/index.js";
import { createSandboxTokenIssuer, SandboxTokenError } from "../adapters/stripe-buyer.js";
import { AppError } from "./errors.js";
import type { Ctx } from "./ctx.js";
import { purchase } from "./payments.js";
import { getJobView } from "./views.js";

/** Bounds token issuance; a merchant submission already in progress is awaited until its own adapter timeout. */
const DEADLINE_MS = 60_000;
export interface DemoPurchaseOptions { deadlineMs?: number }
const USE_CLI = "use the CLI buyer shown under a new quote";
class DeadlineExceeded extends Error {}

/** mppx/client is loaded on first use (or at boot when enabled): deployments with the demo agent off never import it. */
type MppxClient = typeof import("mppx/client");
let mppxClient: Promise<MppxClient> | undefined;
const loadMppxClient = () => (mppxClient ??= import("mppx/client").catch((e) => { mppxClient = undefined; throw e; }));

/** Pays the mppx/client import cost at boot rather than on the first click. Called once from route registration. */
export function prewarmDemoBuyer(ctx: Ctx): void {
  if (ctx.cfg.demoBuyer.enabled) void loadMppxClient().catch((e) => console.error("[demo-buyer] mppx/client failed to load:", "unavailable; check server installation"));
}

// Coalesce clicks in one process for convenience. Postgres is the authority across processes and restarts.
const registries = new WeakMap<Ctx, Map<string, Promise<JobView>>>();
function flightsOf(ctx: Ctx): Map<string, Promise<JobView>> {
  let flights = registries.get(ctx);
  if (!flights) registries.set(ctx, flights = new Map());
  return flights;
}

export async function demoPurchase(ctx: Ctx, clientId: string, jobId: string, options: DemoPurchaseOptions = {}): Promise<JobView> {
  if (!ctx.cfg.demoBuyer.enabled) throw new AppError("NOT_FOUND", "Demo buyer is not enabled on this deployment.");
  const job = await getJobView(ctx, clientId, jobId);
  if (job.payment_state !== "unpaid") return job;
  const flights = flightsOf(ctx);
  const running = flights.get(jobId);
  if (running) return running;
  const done = reserveAndRun(ctx, clientId, job, options.deadlineMs ?? DEADLINE_MS)
    .finally(() => { if (flights.get(jobId) === done) flights.delete(jobId); });
  flights.set(jobId, done);
  return done;
}

async function reserveAndRun(ctx: Ctx, clientId: string, job: JobView, deadlineMs: number): Promise<JobView> {
  let reservation;
  try {
    [reservation] = await ctx.sql`select * from reserve_demo_purchase(${clientId}::uuid, ${job.job_id}::uuid,
      ${ctx.cfg.demoBuyer.perClientDaily}, ${ctx.cfg.demoBuyer.globalDaily})`;
  } catch (error) {
    if (["42883", "42P01"].includes((error as { code?: string }).code ?? "")) {
      throw new AppError("INTERNAL", "Demo buyer database setup is incomplete; apply the demo buyer migration before enabling it.",
        { status: 503, jobId: job.job_id, nextAction: "Ask the operator to apply the pending database migration." });
    }
    if (error instanceof Error && error.message.startsWith("BAD_REQUEST")) {
      throw new AppError("BAD_REQUEST", "The demo agent only pays the USD 0.50 Stripe sandbox pack within its configured limits.", { jobId: job.job_id });
    }
    if (error instanceof Error && error.message === "QUOTE_EXPIRED") {
      throw new AppError("QUOTE_EXPIRED", "The quote expired; request a new one.", { jobId: job.job_id, nextAction: "quote_video" });
    }
    throw error;
  }
  if (reservation?.outcome === "limited") {
    throw new AppError("ALLOWANCE_EXCEEDED", "The daily demo purchase limit is reached. Pay from your own agent (see the CLI instructions) or try again later.",
      { status: 429, retryAfter: 3600, jobId: job.job_id, nextAction: "Use the CLI buyer shown under the quote." });
  }
  if (reservation?.outcome !== "reserved") {
    const view = await getJobView(ctx, clientId, job.job_id);
    if (view.payment_state !== "unpaid") return view;
    throw new AppError("PAYMENT_RECONCILING", "A demo payment was already attempted for this quote. Its reservation cannot be reused, including after an uncertain outcome.",
      { status: 409, jobId: job.job_id, retryable: false, nextAction: "Check this job's payment status. If unpaid, ask the operator to confirm the outcome before creating a new quote; do not pay this quote again." });
  }
  assertEligibleQuote(ctx, job);
  return runFlight(ctx, clientId, job, deadlineMs);
}

/** The CLI buyer's quote checks, verbatim in spirit: only the USD 0.50 Stripe test pack, unexpired, for this job and origin. */
function assertEligibleQuote(ctx: Ctx, job: JobView): void {
  const q = job.quote;
  const jobId = job.job_id;
  if (q.job_id !== jobId || q.payment_mode !== "test" || q.currency.toLowerCase() !== "usd" || q.amount_minor !== 50) {
    throw new AppError("BAD_REQUEST", "The demo agent only pays the USD 0.50 Stripe sandbox pack.", { jobId, nextAction: `Inspect the quote, or ${USE_CLI}.` });
  }
  if (Date.parse(q.expires_at) <= Date.now()) {
    throw new AppError("QUOTE_EXPIRED", "The quote expired; request a new one.", { jobId, nextAction: "quote_video" });
  }
  const url = new URL(q.purchase_url);
  if (url.origin !== new URL(ctx.cfg.publicOrigin).origin || url.pathname !== `/v1/jobs/${jobId}/purchase`) {
    throw new AppError("BAD_REQUEST", "The quote's purchase URL does not match this job and origin.", { jobId, nextAction: `Inspect the quote, or ${USE_CLI}.` });
  }
}

/** A durable reservation is never released, even when token issuance or outcome persistence fails. */
async function mark(ctx: Ctx, quoteId: string, state: "token_issued" | "succeeded" | "unknown" | "failed") {
  await ctx.sql`select mark_demo_purchase(${quoteId}::uuid, ${state})`;
}

async function runFlight(ctx: Ctx, clientId: string, job: JobView, deadlineMs: number): Promise<JobView> {
  const jobId = job.job_id;
  const quote = job.quote;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), deadlineMs);
  let failed = false;
  const purchaseUrl = new URL(`/v1/jobs/${jobId}/purchase`, ctx.cfg.publicOrigin).href;
  try {
    const { secretKey } = requireStripe(ctx.cfg);
    const { Mppx, stripe } = await loadMppxClient();
    const issueToken = createSandboxTokenIssuer({
      quote, key: secretKey, testNetworkId: "internal", apiBase: ctx.cfg.stripeApiBase,
      fetchImpl: (url, init) => fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal }),
    });
    const createToken: typeof issueToken = async (request) => {
      if (deadline.signal.aborted) throw new DeadlineExceeded();
      const token = await issueToken(request);
      // Persist before giving the credential to mppx. If persistence fails, no charge starts and no repeat is allowed.
      await mark(ctx, quote.quote_id, "token_issued");
      return token;
    };
    const mppx = Mppx.create({
      polyfill: false, maxPaymentRetries: 1,
      methods: [stripe.charge({ paymentMethod: "pm_card_visa", createToken })],
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.method !== "POST" || request.url !== purchaseUrl) {
          throw new AppError("BAD_REQUEST", "Demo buyer transport only accepts this job's purchase endpoint.", { jobId });
        }
        if (deadline.signal.aborted) throw new DeadlineExceeded();
        // Once purchase starts, await its bounded Stripe adapter. A timer must never detach a running charge.
        return purchase(ctx, clientId, jobId, request);
      }) as typeof fetch,
    });
    const response = await mppx.fetch(purchaseUrl, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quote_id: quote.quote_id }), redirect: "error",
    });
    if (response.status === 200 || response.status === 202) {
      const view = await getJobView(ctx, clientId, jobId);
      await mark(ctx, quote.quote_id, view.payment_state === "paid" ? "succeeded" : "unknown");
      return view;
    }
    if (response.status === 402) {
      await mark(ctx, quote.quote_id, "failed");
      failed = true;
      throw new AppError("PAYMENT_REQUIRED", "Stripe did not accept the sandbox payment. This quote's demo attempt has been consumed.",
        { jobId, retryable: false, nextAction: `Check the job status before requesting a new quote, or ${USE_CLI}.` });
    }
    throw new Error("Unexpected demo purchase response");
  } catch (error) {
    // A paid/reconciling merchant row remains the authority even if the browser or demo bookkeeping failed.
    const view = await getJobView(ctx, clientId, jobId);
    if (view.payment_state !== "unpaid") {
      await mark(ctx, quote.quote_id, view.payment_state === "paid" ? "succeeded" : "unknown").catch(() => {
        console.error("[demo-buyer] outcome persistence failed; reservation remains consumed");
      });
      return view;
    }
    if (!failed) await mark(ctx, quote.quote_id, error instanceof SandboxTokenError && !error.transient ? "failed" : "unknown").catch(() => {
      console.error("[demo-buyer] outcome persistence failed; reservation remains consumed");
    });
    if (error instanceof AppError) throw error;
    const timedOut = deadline.signal.aborted || error instanceof DeadlineExceeded;
    throw new AppError("INTERNAL", timedOut
      ? "The demo payment deadline expired. The quote's demo reservation remains consumed; no automatic retry will occur."
      : error instanceof SandboxTokenError ? error.message : "The demo agent could not confirm the payment outcome. Its reservation remains consumed.",
      { status: timedOut ? 504 : 502, jobId, retryable: false,
        nextAction: "Check this job's payment status. Ask the operator to confirm the outcome before creating a new quote; do not pay this quote again." });
  } finally {
    clearTimeout(timer);
  }
}
