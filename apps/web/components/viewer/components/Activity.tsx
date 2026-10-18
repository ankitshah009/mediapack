import type { JobEvent } from "../api/client";
import { clock, offset } from "../lib/format";
import { Empty } from "./ui";

type Source = "Stripe" | "Primitive" | "Worker" | "MediaPack";
const SRC: Record<Source, { text: string; dot: string }> = {
  Stripe: { text: "text-stripe", dot: "bg-stripe" },
  Primitive: { text: "text-primitive", dot: "bg-primitive" },
  Worker: { text: "text-worker", dot: "bg-worker" },
  MediaPack: { text: "text-muted", dot: "bg-muted" },
};

export function sourceOf(kind: string): Source {
  if (/^(payment|stripe)\./.test(kind)) return "Stripe";
  if (/^primitive\./.test(kind)) return "Primitive";
  if (/^(worker|blaxel)\./.test(kind)) return "Worker";
  return "MediaPack";
}

const TITLES: Record<string, string> = {
  "quote.issued": "Quote issued",
  "payment.challenge": "Payment required (402)",
  "payment.verified": "Payment verified",
  "payment.reconciling": "Payment outcome pending",
  "primitive.request_sent": "Work request sent",
  "primitive.request_delivered": "Work request delivered",
  "primitive.result_received": "Result received",
  "worker.launched": "Worker launched",
  "worker.started": "Worker started",
  "operation.queued": "Operation queued",
  "operation.succeeded": "Operation succeeded",
  "operation.failed": "Operation failed",
  "operation.retried": "Operation retried",
};
const title = (k: string) => TITLES[k] ?? k.replace(/[._]/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** Pick a few human-meaningful detail fields; the full payload stays available in a disclosure. */
const SHOW = ["action", "kind", "code", "message", "message_id", "email_id", "payment_intent_id", "amount_minor", "mode", "generation", "attempt", "state"];
function summarize(d: Record<string, unknown>): [string, string][] {
  const out: [string, string][] = [];
  for (const k of SHOW) {
    const v = d[k];
    if (v === undefined || v === null || typeof v === "object") continue;
    out.push([k, String(v)]);
    if (out.length === 3) break;
  }
  return out;
}

export function ActivityFeed({ events, error }: { events: JobEvent[]; error?: string }) {
  if (events.length === 0) {
    return error ? (
      <p role="alert" className="text-sm text-danger">{error}</p>
    ) : (
      <Empty title="No activity yet">Events appear here as the quote, payment, dispatch and worker report in.</Empty>
    );
  }
  const t0 = events[0].created_at;
  return (
    <div>
      <p className="mb-2 text-[11px] text-muted">Times are runtime offsets from the first event, not video timestamps.</p>
      {error && <p role="alert" className="mb-2 text-xs text-danger">{error}</p>}
      <ol className="relative flex flex-col gap-3 border-l border-line pl-4" aria-label="Job events">
        {events.map((e) => {
          const s = sourceOf(e.kind);
          const sum = summarize(e.details);
          return (
            <li key={e.id} className="relative">
              <span className={`absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full ring-2 ring-paper ${SRC[s].dot}`} aria-hidden="true" />
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-sm font-medium">{title(e.kind)}</p>
                <time dateTime={e.created_at} title={`${new Date(e.created_at).toLocaleString()}`} className="shrink-0 font-mono text-[11px] text-muted">
                  {offset(e.created_at, t0)}
                </time>
              </div>
              <p className="text-[11px]">
                <span className={`font-semibold ${SRC[s].text}`}>{s}</span>
                <span className="text-muted"> · {clock(e.created_at)}</span>
              </p>
              {sum.length > 0 && (
                <p className="mt-0.5 break-all font-mono text-[11px] text-muted">{sum.map(([k, v]) => `${k}=${v}`).join("  ")}</p>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
