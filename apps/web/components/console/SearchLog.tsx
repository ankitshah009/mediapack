"use client";

import type { JobView } from "@/lib/reduce";
import { ts } from "@/lib/format";

export function SearchLog({ view, setT }: { view: JobView; setT: (t: number) => void }) {
  return (
    <section className="rounded-2xl border border-line bg-card p-5 sm:p-6">
      <header>
        <h3 className="font-display text-lg tracking-tight">Agent queries</h3>
        <p className="mt-0.5 font-mono text-xs text-muted">search_video · text only, no pixels</p>
      </header>

      {view.searches.length === 0 ? (
        <p className="mt-5 rounded-xl border border-dashed border-line px-4 py-6 text-sm text-muted">
          Waiting for the index — the agent&apos;s searches will appear here.
        </p>
      ) : (
        <ol className="mt-5 space-y-6">
          {view.searches.map((s, i) => (
            <li key={`${s.at}-${i}`} className="animate-rise">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <code className="break-words font-mono text-[13px]">
                  search_video(&quot;{s.query}&quot;)
                </code>
                <span className="rounded-full bg-lime px-2 py-0.5 font-mono text-[11px] font-medium text-lime-ink">
                  +{s.text_tokens} tokens
                </span>
              </div>
              <ul className="mt-3 space-y-3 border-l border-line pl-4">
                {s.hits.map((h, j) => (
                  <li key={j} className="space-y-1.5">
                    <div className="flex items-start gap-3">
                      <button
                        type="button"
                        onClick={() => setT(h.start_ms)}
                        aria-label={`Seek to ${ts(h.start_ms)}`}
                        className="shrink-0 rounded-md border border-line px-1.5 py-0.5 font-mono text-xs transition hover:bg-lime hover:text-lime-ink focus-visible:outline-2 focus-visible:outline-stripe"
                      >
                        {ts(h.start_ms)}–{ts(h.end_ms)}
                      </button>
                      <p className="min-w-0 text-sm">{h.caption}</p>
                    </div>
                    <div
                      role="meter"
                      aria-label="Relevance score"
                      aria-valuemin={0}
                      aria-valuemax={1}
                      aria-valuenow={h.score}
                      className="flex items-center gap-2"
                    >
                      <div className="h-1 w-24 overflow-hidden rounded-full bg-line">
                        <div
                          className="h-full rounded-full bg-lime"
                          style={{ width: `${Math.round(Math.min(1, Math.max(0, h.score)) * 100)}%` }}
                        />
                      </div>
                      <span className="font-mono text-[11px] text-muted">{h.score.toFixed(2)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
