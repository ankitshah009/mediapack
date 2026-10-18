import { useState } from "react";
import type { JobEvent, OperationView } from "../api/client";
import { clock, offset } from "../lib/format";
import { groupSteps, stage, title } from "../lib/steps";
import { Badge, Empty } from "./ui";

type Source = "Stripe" | "Primitive" | "Worker" | "MediaPack";
const SRC: Record<Source, { text: string; dot: string; chip: string }> = {
  Stripe: { text: "text-stripe", dot: "bg-stripe", chip: "bg-stripe-soft text-stripe" },
  Primitive: { text: "text-primitive", dot: "bg-primitive", chip: "bg-primitive/15 text-primitive" },
  Worker: { text: "text-worker", dot: "bg-worker", chip: "bg-worker/15 text-worker" },
  MediaPack: { text: "text-muted", dot: "bg-muted", chip: "bg-line text-text" },
};

export function sourceOf(kind: string): Source {
  if (/^(payment|stripe)\./.test(kind)) return "Stripe";
  if (/^primitive\./.test(kind)) return "Primitive";
  if (/^(worker|blaxel)\./.test(kind)) return "Worker";
  return "MediaPack";
}

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

function elapsed(a: string, b: string): string {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;
}

const STATUS = {
  done: { dot: "bg-ok", badge: "ok" as const, text: "done" },
  failed: { dot: "bg-danger", badge: "danger" as const, text: "failed" },
  active: { dot: "bg-worker animate-pulse", badge: "warn" as const, text: "running" },
};

export function ActivityFeed({ events, operations, error }: { events: JobEvent[]; operations?: OperationView[]; error?: string }) {
  const [raw, setRaw] = useState(false);
  if (events.length === 0) {
    return error ? (
      <p role="alert" className="text-sm text-danger">{error}</p>
    ) : (
      <Empty title="No activity yet">Events appear here as the quote, payment, dispatch and worker report in.</Empty>
    );
  }
  const t0 = events[0].created_at;
  const steps = groupSteps(events, operations);
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-[11px] text-muted">{steps.length} steps · {events.length} persisted events</p>
        <button type="button" onClick={() => setRaw((r) => !r)} className="text-[11px] font-medium text-muted underline-offset-2 hover:text-text hover:underline" aria-pressed={raw}>
          {raw ? "Show steps" : "Show raw events"}
        </button>
      </div>
      {error && <p role="alert" className="mb-2 text-xs text-danger">{error}</p>}
      {raw ? <RawEvents events={events} t0={t0} /> : (
        <ol className="flex flex-col gap-2" aria-label="Job steps">
          {steps.map((s) => {
            const first = s.events[0].created_at;
            const last = s.events[s.events.length - 1].created_at;
            const st = STATUS[s.status];
            return (
              <li key={s.key} className="rounded-xl border border-line bg-paper px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="flex min-w-0 items-center gap-2 text-sm font-medium">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${st.dot}`} aria-hidden="true" />
                    <span className="truncate">{s.label}</span>
                  </p>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {s.status !== "done" && <Badge tone={st.badge}>{st.text}</Badge>}
                    <time dateTime={first} title={new Date(first).toLocaleString()} className="font-mono text-[11px] text-muted">{offset(first, t0)}</time>
                  </span>
                </div>
                {s.detail && <p className="mt-0.5 truncate pl-4 text-[11px] text-muted" title={s.detail}>{s.detail}</p>}
                <p className="mt-1.5 flex flex-wrap items-center gap-1 pl-4" aria-label={`${s.label} stages`}>
                  {dedupe(s.events).map((e, i) => (
                    <span key={e.id} className="flex items-center gap-1">
                      {i > 0 && <span className="text-[10px] text-muted" aria-hidden="true">→</span>}
                      <span className={`rounded-full px-1.5 py-px text-[10px] font-medium leading-4 ${SRC[sourceOf(e.kind)].chip}`} title={`${title(e.kind)} · ${clock(e.created_at)}`}>
                        {stage(e.kind)}
                      </span>
                    </span>
                  ))}
                  {elapsed(first, last) && <span className="ml-1 font-mono text-[10px] text-muted">{elapsed(first, last)}</span>}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/** Collapse consecutive repeats of the same stage (e.g. a retry loop) into one chip. */
function dedupe(events: JobEvent[]): JobEvent[] {
  return events.filter((e, i) => i === 0 || stage(e.kind) !== stage(events[i - 1].kind));
}

function RawEvents({ events, t0 }: { events: JobEvent[]; t0: string }) {
  return (
    <>
      <p className="mb-2 text-[11px] text-muted">Times are runtime offsets from the first event, not video timestamps.</p>
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
    </>
  );
}
