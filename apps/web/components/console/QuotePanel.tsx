"use client";

import { Check, ExternalLink, Loader2, Play } from "lucide-react";
import type { JobView } from "@/lib/reduce";
import type { Scenario } from "@/lib/scenario";
import { num, secs, ts, usd } from "@/lib/format";
import { Frame } from "./Frames";

export function QuotePanel({
  sc,
  view,
  onApprove,
}: {
  sc: Scenario;
  view: JobView;
  onApprove: () => void;
}) {
  const quote = view.quote;
  if (!quote) return null;
  const paying = view.phase === "paying";
  const { allowance } = quote;

  const stats: { value: string; label: string }[] = [
    { value: num(allowance.text_tokens), label: "text tokens" },
    { value: num(allowance.frames), label: "frames" },
    { value: secs(allowance.clip_ms), label: "clip" },
  ];

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
      <div className="space-y-6">
        <section className="rounded-2xl border border-line bg-card p-6 sm:p-8">
          <p className="font-mono text-[11px] uppercase tracking-wider text-muted">
            Task from {view.requestedBy ?? "agent"}
          </p>
          <blockquote className="mt-4 border-l-2 border-lime pl-5 font-display text-2xl leading-snug tracking-tight sm:text-3xl">
            <span aria-hidden className="text-muted">&ldquo;</span>
            {view.task}
            <span aria-hidden className="text-muted">&rdquo;</span>
          </blockquote>
        </section>

        <section className="flex flex-col gap-5 rounded-2xl border border-line bg-card p-4 sm:flex-row sm:items-center sm:p-5">
          <div className="relative aspect-[16/10] w-full shrink-0 overflow-hidden rounded-xl border border-line sm:w-56">
            <Frame state={sc.frameAt(0)} className="h-full w-full" />
            <span className="absolute inset-0 flex items-center justify-center bg-black/20">
              <span className="flex size-10 items-center justify-center rounded-full bg-white/90 text-black shadow">
                <Play className="size-4 translate-x-px fill-current" aria-hidden />
              </span>
            </span>
          </div>
          <div className="min-w-0">
            <p className="truncate font-mono text-sm" title={view.sourceName}>
              {view.sourceName}
            </p>
            <p className="mt-1 text-sm text-muted">
              <span className="font-mono">{ts(view.durationMs)}</span> · Video received
            </p>
            <p className="mt-3 text-xs text-muted">
              Delivered to the worker <span className="text-primitive">via Primitive</span>
            </p>
          </div>
        </section>

        <section className="rounded-2xl border border-line bg-card p-6 sm:p-8">
          <p className="font-mono text-[11px] uppercase tracking-wider text-muted">
            Maximum media returned
          </p>
          <dl className="mt-5 grid grid-cols-3 gap-4">
            {stats.map((s) => (
              <div key={s.label}>
                <dd className="font-display text-3xl tracking-tight sm:text-5xl">{s.value}</dd>
                <dt className="mt-1 text-xs text-muted sm:text-sm">{s.label}</dt>
              </div>
            ))}
          </dl>
          <p className="mt-6 text-sm text-muted">
            The agent selects evidence within this allowance.
          </p>
        </section>
      </div>

      <aside
        aria-label="Price"
        className="rounded-2xl border border-line bg-card p-6 sm:p-8 lg:sticky lg:top-6"
      >
        <p className="font-mono text-[11px] uppercase tracking-wider text-muted">
          JOB {view.jobId}
        </p>
        <h2 className="mt-4 text-sm font-medium">Quote ready</h2>
        <p className="mt-2 font-display text-7xl leading-none tracking-tighter">
          {usd(quote.amount_cents)}
        </p>
        <p className="mt-3 text-sm text-muted">Fixed job price · USD</p>

        <ul className="mt-6 space-y-3 text-sm">
          {[
            `One video up to ${ts(allowance.max_duration_ms)}`,
            "Timestamped text and frames",
            "One source clip",
          ].map((item) => (
            <li key={item} className="flex items-start gap-3">
              <Check className="mt-0.5 size-4 shrink-0 text-primitive" aria-hidden />
              <span>{item}</span>
            </li>
          ))}
        </ul>

        <hr className="my-6 border-line" />

        <div className="flex items-center justify-between gap-3">
          <span className="font-display text-lg font-semibold tracking-tight text-stripe">
            stripe
          </span>
          <span className="text-xs text-muted">Sandbox purchase</span>
        </div>
        {view.challengeId && (
          <p className="mt-2 break-all font-mono text-xs text-muted">{view.challengeId}</p>
        )}

        <button
          type="button"
          onClick={onApprove}
          disabled={paying}
          aria-busy={paying}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-lime px-5 py-4 text-base font-semibold text-lime-ink transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stripe disabled:cursor-wait disabled:opacity-80"
        >
          {paying ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Waiting for Link approval…
            </>
          ) : (
            <>
              Approve in Link
              <ExternalLink className="size-4" aria-hidden />
            </>
          )}
        </button>
        {paying && (
          <p role="status" className="mt-3 text-center text-sm text-stripe">
            Spend request sent to your Link wallet
          </p>
        )}

        <p className="mt-5 text-center text-xs text-muted">
          Processing starts after payment is verified.
        </p>
      </aside>
    </div>
  );
}
