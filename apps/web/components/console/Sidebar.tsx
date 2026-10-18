"use client";

import { num, rel, secs, ts, usd } from "@/lib/format";
import type { JobView } from "@/lib/reduce";
import type { JobEvent, Source } from "@/lib/types";

const SRC: Record<Source, { name: string; text: string; dot: string }> = {
  api: { name: "MediaPack", text: "text-muted", dot: "bg-muted" },
  stripe: { name: "Stripe", text: "text-stripe", dot: "bg-stripe" },
  primitive: { name: "Primitive", text: "text-primitive", dot: "bg-primitive" },
  worker: { name: "Worker", text: "text-worker", dot: "bg-worker" },
  agent: { name: "Agent", text: "text-agent", dot: "bg-agent" },
};

function describe(e: JobEvent): { title: string; detail?: string } {
  switch (e.type) {
    case "job.created":
      return { title: `Job created · ${e.data.source_name}`, detail: e.data.requested_by };
    case "quote.issued":
      return { title: `Quote issued · ${usd(e.data.amount_cents)}`, detail: `expires ${e.data.expires_at}` };
    case "payment.challenge":
      return { title: "Payment required (402)", detail: e.data.challenge_id };
    case "payment.verified":
      return {
        title: `Payment verified · ${e.data.mode} mode`,
        detail: e.data.payment_id,
      };
    case "primitive.dispatched":
      return { title: `Work request delivered to ${e.data.to}`, detail: e.data.message_id };
    case "worker.started":
      return { title: "Worker started", detail: e.data.sandbox_id };
    case "worker.progress":
      return { title: `Indexing · ${e.data.stage}`, detail: `${Math.round(e.data.pct)}%` };
    case "worker.indexed":
      return {
        title: `Indexed ${num(e.data.segments)} segments in ${(e.data.ms_elapsed / 1000).toFixed(1)}s`,
        detail: `${num(e.data.keyframes)} keyframes`,
      };
    case "agent.search":
      return { title: `Searched "${e.data.query}"`, detail: `${e.data.hits.length} hits · ${num(e.data.text_tokens)} tokens` };
    case "agent.retrieved":
      return {
        title: `Pulled ${e.data.frames_ms.length} frames · ${secs(e.data.clip_ms)} clip`,
        detail: `${ts(e.data.start_ms)}–${ts(e.data.end_ms)}`,
      };
    case "primitive.delivered":
      return { title: "Results delivered", detail: e.data.message_id };
    case "report.ready":
      return { title: "Report written", detail: e.data.report.title };
  }
}

function collapse(events: JobEvent[]): JobEvent[] {
  const out: JobEvent[] = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (e.type === "worker.progress" && last?.type === "worker.progress") out[out.length - 1] = e;
    else out.push(e);
  }
  return out;
}

export function ActivityFeed({ view }: { view: JobView }) {
  const items = collapse(view.events);
  const base = view.events[0]?.created_at;
  return (
    <section aria-labelledby="activity-h">
      <h2 id="activity-h" className="mb-3 font-display text-sm font-semibold tracking-tight">
        Agent activity
      </h2>
      {items.length === 0 ? (
        <p className="text-xs text-muted">Waiting for events…</p>
      ) : (
        <ol className="relative">
          {items.map((e, i) => {
            const s = SRC[e.source];
            const { title, detail } = describe(e);
            const last = i === items.length - 1;
            return (
              <li key={e.id} className="animate-rise relative flex gap-3 pb-4 last:pb-0">
                {!last && <span aria-hidden="true" className="absolute left-[5px] top-3 h-full w-px bg-line" />}
                <span
                  aria-hidden="true"
                  className={`relative mt-1 h-[11px] w-[11px] shrink-0 rounded-full ${s.dot} ${
                    last ? "ring-4 ring-lime/50" : ""
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={`text-[11px] font-semibold uppercase tracking-wide ${s.text}`}>{s.name}</span>
                    {base && <span className="font-mono text-[10px] text-muted">{rel(base, e.created_at)}</span>}
                  </div>
                  <p className="text-[13px] leading-snug text-text">{title}</p>
                  {detail && <p className="mt-0.5 break-all font-mono text-[11px] text-muted">{detail}</p>}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function Meter({ label, used, cap, fmt }: { label: string; used: number; cap: number; fmt: (n: number) => string }) {
  const over = used > cap;
  const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-muted">{label}</span>
        <span className="font-mono tabular-nums">
          <span className={over ? "text-red-600" : ""}>{fmt(used)}</span>
          <span className="text-muted"> / {fmt(cap)}</span>
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={cap}
        aria-valuenow={Math.min(used, cap)}
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line"
      >
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${over ? "bg-red-500" : "bg-lime"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function UsageMeters({ view }: { view: JobView }) {
  const a = view.quote?.allowance;
  if (!a) return null;
  const u = view.usage;
  const exceeded = u.text_tokens > a.text_tokens || u.frames > a.frames || u.clip_ms > a.clip_ms;
  return (
    <section aria-labelledby="usage-h" className="rounded-2xl border border-line bg-card p-4">
      <h2 id="usage-h" className="mb-3 font-display text-sm font-semibold tracking-tight">
        Returned media
      </h2>
      <div className="flex flex-col gap-3">
        <Meter label="Text tokens" used={u.text_tokens} cap={a.text_tokens} fmt={num} />
        <Meter label="Frames" used={u.frames} cap={a.frames} fmt={num} />
        <Meter label="Clip length" used={u.clip_ms} cap={a.clip_ms} fmt={secs} />
      </div>
      <p className={`mt-3 text-xs font-medium ${exceeded ? "text-red-600" : "text-text"}`}>
        {exceeded ? "Allowance exceeded — further pulls need a new quote." : "Within the purchased allowance."}
      </p>
      <p className="mt-1 text-[11px] text-muted">Counts media returned to the agent, not media processed.</p>
    </section>
  );
}

export function Receipt({ view }: { view: JobView }) {
  if (!view.payment) return null;
  const p = view.payment;
  const cost = view.index?.cost_cents;
  return (
    <section aria-labelledby="receipt-h" className="animate-rise rounded-2xl border border-line bg-card p-4">
      <div className="flex items-center justify-between">
        <h2 id="receipt-h" className="text-sm">
          <span className="font-semibold text-stripe">stripe</span>
          <span className="ml-2 text-muted">Test payment</span>
        </h2>
        {p.mode === "test" && (
          <span className="rounded-full bg-stripe/10 px-2 py-0.5 text-[10px] font-medium text-stripe">TEST</span>
        )}
      </div>
      <p className="mt-2 font-display text-4xl font-semibold tracking-tight tabular-nums">{usd(p.amount_cents)}</p>
      <p className="text-xs text-muted">One job · Paid once</p>
      <p className="mt-2 break-all font-mono text-[11px] text-muted">{p.payment_id}</p>

      {view.delivery && (
        <p className="mt-3 flex items-center gap-1.5 border-t border-line pt-3 text-xs">
          <span className="h-1.5 w-1.5 rounded-full bg-primitive" aria-hidden="true" />
          <span className="text-primitive font-medium">Delivered via Primitive</span>
          <span className="text-muted">· {view.delivery.artifacts} artifacts</span>
        </p>
      )}
      {view.index && cost !== undefined && (
        <dl className="mt-3 space-y-1 border-t border-line pt-3 text-xs">
          <div className="flex justify-between">
            <dt className="text-muted">Your cost to serve</dt>
            <dd className="font-mono">{usd(cost)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">Index time</dt>
            <dd className="font-mono">{(view.index.ms_elapsed / 1000).toFixed(1)}s</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">Margin</dt>
            <dd className="font-mono">{usd(p.amount_cents - cost)}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}
