import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Api, ApiError, type JobView, type ViewerMe } from "../api/client";
import { toApiError } from "../api/hooks";
import {
  demoAgentOffered, demoFailureLocksPayment, describeDemoPayFailure, readDemoPayAttempt, writeDemoPayAttempt,
  type DemoPayAttempt,
} from "../lib/demoPay";
import { Badge, Button } from "./ui";

const CHANGE_EVENT = "mp:demo-pay-change";
const serverSnapshot = () => "idle" as const;

function subscribeToAttempts(notify: () => void) {
  window.addEventListener("storage", notify);
  window.addEventListener(CHANGE_EVENT, notify);
  return () => {
    window.removeEventListener("storage", notify);
    window.removeEventListener(CHANGE_EVENT, notify);
  };
}

function savedAttempt(quoteId: string): DemoPayAttempt {
  try { return readDemoPayAttempt(window.localStorage, quoteId); }
  catch { return "idle"; } // A click must successfully save its marker before it may send a payment request.
}

function rememberAttempt(quoteId: string, phase: DemoPayAttempt) {
  writeDemoPayAttempt(window.localStorage, quoteId, phase);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/**
 * One GET /viewer/me per mount says whether this deployment lets the browser pay through the server-side demo agent;
 * `pay` is the single POST that makes it answer the HTTP 402 challenge. Nothing is simulated: the job page's own
 * polling shows the payment landing, and `onPaid` only asks it to look right away.
 */
export function useDemoAgent(job: JobView, now: number, onPaid?: () => void) {
  const [me, setMe] = useState<ViewerMe>();
  const [paying, setPaying] = useState(false);
  const [attempt, setAttempt] = useState<DemoPayAttempt>("idle");
  const [error, setError] = useState<ApiError>();
  const locked = useRef(false);
  const quoteId = job.quote.quote_id;
  const storedPhase = useSyncExternalStore(subscribeToAttempts, () => savedAttempt(quoteId), serverSnapshot);
  const phase = paying ? "paying" : attempt !== "idle" ? attempt : storedPhase;

  useEffect(() => {
    const ctl = new AbortController();
    Api.me(ctl.signal).then((value) => { if (!ctl.signal.aborted) setMe(value); }, () => {
      /* probe failed: no demo button, the CLI tabs stay the way to pay */
    });
    return () => ctl.abort();
  }, []);

  async function pay() {
    if (locked.current || savedAttempt(quoteId) !== "idle" || !demoAgentOffered(me, job, Date.now())) return;
    locked.current = true;
    setError(undefined);
    try {
      // Reserve the browser action before any network I/O, so reloads and other tabs cannot offer a second click.
      rememberAttempt(quoteId, "submitted");
      setAttempt("submitted");
    } catch {
      locked.current = false;
      setError(new ApiError(0, "LOCAL_STATE_UNAVAILABLE", "The browser could not remember this payment attempt."));
      return;
    }
    setPaying(true);
    try {
      await Api.demoPurchase(job.job_id);
      // Keep the marker until the real job flips to paid/reconciling; a successful response is never a second-click invitation.
    } catch (e) {
      const err = toApiError(e);
      const failure = describeDemoPayFailure(err);
      const keepLocked = demoFailureLocksPayment(failure);
      setError(err);
      const next = keepLocked ? failure.kind === "unknown" ? "unknown" : "blocked" : "idle";
      try {
        rememberAttempt(quoteId, next);
        setAttempt(next);
        if (!keepLocked) locked.current = false;
      } catch {
        setAttempt("unknown"); // Keep this render locked even if browser storage stops accepting writes.
      }
    } finally {
      setPaying(false);
      onPaid?.(); // Re-read persisted payment state after every outcome, including a lost response.
    }
  }

  return {
    offered: demoAgentOffered(me, job, now),
    phase,
    error,
    failure: error && describeDemoPayFailure(error),
    pay,
  };
}

export type DemoAgent = ReturnType<typeof useDemoAgent>;

/** The one-click browser purchase. Rendered above the CLI tabs, only while the quote is unpaid and open. */
export function DemoAgentPay({ agent }: { agent: DemoAgent }) {
  const { phase, error, failure, pay } = agent;
  // `expired` is handled by the quote panel (fresh-quote button), so it never shows as an inline error.
  const problem = failure && failure.kind !== "expired" ? failure : undefined;
  const alertBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The disabled button drops keyboard focus to <body> while the request runs: bring the user back to the outcome,
    // unless they have already moved on. Tab from here reaches the CLI tabs the message points to.
    if (error && (!document.activeElement || document.activeElement === document.body)) alertBox.current?.focus();
  }, [error]);
  return (
    <div className="rounded-xl border border-line bg-paper p-4">
      {problem?.kind !== "unavailable" && problem?.kind !== "limit" && (
        <>
          <Button
            variant="primary"
            className="w-full sm:w-auto"
            busy={phase === "paying"}
            disabled={phase !== "idle"}
            aria-describedby="demo-pay-note"
            onClick={pay}
          >
            {phase === "paying" ? "Verifying payment…" : phase !== "idle" ? "Payment status pending" : "Pay $0.50 with demo agent (test mode)"}
          </Button>
          <p id="demo-pay-note" className="mt-2 text-xs text-muted">
            Uses the server&apos;s demo wallet in Stripe test mode. No real money is charged.
          </p>
        </>
      )}

      <div role="status">
        {phase === "paying" && (
          <p className="mt-3 text-sm">
            Payment is being verified. This page updates automatically from the saved job status.
          </p>
        )}
        {phase !== "idle" && phase !== "paying" && (
          <p className="mt-3 text-sm">A payment attempt is recorded for this quote. Do not pay it again. This page keeps checking its saved status; ask the operator to confirm the outcome before requesting another quote.</p>
        )}
      </div>

      {problem && error && (
        <div
          ref={alertBox}
          role="alert"
          tabIndex={-1}
          className="mt-3 rounded-xl border border-danger/30 bg-danger-soft p-3 text-sm"
        >
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium text-danger">{problem.title}</p>
            <Badge tone="danger">{error.code}</Badge>
          </div>
          <p className="mt-0.5 wrap-anywhere">{error.message}</p>
          <p className="mt-1 text-xs text-muted">{problem.hint}</p>
          {error.nextAction && <p className="mt-1 text-xs text-muted">{error.nextAction}</p>}
        </div>
      )}
    </div>
  );
}
