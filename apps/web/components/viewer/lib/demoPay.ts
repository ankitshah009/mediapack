import type { ApiError, JobView, ViewerMe } from "../api/client";

/** Match the server's fixed demo pack, authenticated owner and quote eligibility. Missing capability means off. */
export function demoAgentOffered(
  me: Pick<ViewerMe, "authenticated" | "demo_buyer"> | undefined,
  job: Pick<JobView, "job_id" | "payment_state" | "state" | "quote">,
  now: number,
): boolean {
  const q = job.quote;
  return me?.authenticated === true && me.demo_buyer === true && job.payment_state === "unpaid" &&
    job.state === "awaiting_payment" && q.payment_mode === "test" && q.amount_minor === 50 &&
    q.currency.toLowerCase() === "usd" && q.job_id === job.job_id && Date.parse(q.expires_at) > now;
}

export type DemoPayAttempt = "idle" | "submitted" | "unknown" | "blocked";
type AttemptStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const attemptKey = (quoteId: string) => `mp:demo-pay:${quoteId}`;

/** A marker is written before the POST; reloads and other tabs must not offer another payment for that quote. */
export function readDemoPayAttempt(storage: AttemptStorage, quoteId: string): DemoPayAttempt {
  const value = storage.getItem(attemptKey(quoteId));
  if (value === null) return "idle";
  return value === "submitted" || value === "blocked" ? value : "unknown";
}

export function writeDemoPayAttempt(storage: AttemptStorage, quoteId: string, phase: DemoPayAttempt): void {
  if (phase === "idle") storage.removeItem(attemptKey(quoteId));
  else storage.setItem(attemptKey(quoteId), phase);
  if (readDemoPayAttempt(storage, quoteId) !== phase) throw new Error("Payment state could not be saved.");
}

/** `expired` is shown by the quote panel itself (fresh-quote button); every other kind renders the title, the server's message and the hint. */
export type DemoPayFailure =
  | { kind: "expired" }
  | { kind: "limit" | "unavailable" | "session" | "invalid" | "storage" | "unknown" | "pending" | "failed"; title: string; hint: string };

/** UI copy for a failed demo purchase. The server's own message is always shown next to this title and hint. */
export function describeDemoPayFailure(e: Pick<ApiError, "code" | "status" | "retryable" | "unstructured">): DemoPayFailure {
  if (e.code === "QUOTE_EXPIRED") return { kind: "expired" };
  // Only the pre-reservation 429 is a safe daily-cap refusal; other payment errors keep the quote locked.
  if (e.status === 429) {
    return { kind: "limit", title: "Demo agent limit reached", hint: "You can still pay this quote with the commands below." };
  }
  if (e.code === "NOT_FOUND") {
    return {
      kind: "unavailable",
      title: "Demo agent unavailable",
      hint: "It cannot be used for this job right now. Pay from your own agent with the commands below.",
    };
  }
  if (e.code === "UNAUTHORIZED") {
    return { kind: "session", title: "No browser session", hint: "Start or pair a browser session, then try again." };
  }
  if (e.code === "BAD_REQUEST" && e.status === 400) {
    return { kind: "invalid", title: "This quote cannot use the demo wallet", hint: "Check the quote details, or use your own agent with the commands below." };
  }
  if (e.code === "LOCAL_STATE_UNAVAILABLE") {
    return { kind: "storage", title: "Could not save payment progress", hint: "Allow this site to store payment progress before using the demo agent, or pay with your own agent below. No demo request was sent." };
  }
  if (e.code === "PAYMENT_RECONCILING") {
    return {
      kind: "pending", title: "A demo payment attempt is already recorded",
      hint: "Do not pay this quote again. This page keeps checking its saved payment status. Ask the operator to confirm the outcome before requesting a new quote.",
    };
  }
  // A server-side 5xx can follow a durable reservation or an in-flight Stripe call, even with a JSON envelope.
  if (e.code === "NETWORK" || e.status >= 500 || e.unstructured) {
    return {
      kind: "unknown",
      title: "Could not confirm the payment",
      hint: "The outcome is unknown. Do not pay this quote again. This page updates from the saved job status; ask the operator to confirm the outcome before requesting a new quote.",
    };
  }
  return {
    kind: "failed",
    title: "Demo agent payment failed",
    hint: "The demo attempt for this quote is reserved. Do not pay it again. Check the saved job status and ask the operator to confirm the outcome before requesting a new quote.",
  };
}

/** These routes reject before reserving a demo attempt; every other response keeps the browser locked. */
export function demoFailureLocksPayment(failure: DemoPayFailure): boolean {
  return failure.kind === "unknown" || failure.kind === "pending" || failure.kind === "failed";
}
