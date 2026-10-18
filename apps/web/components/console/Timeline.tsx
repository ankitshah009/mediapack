"use client";

import type { Dispatch, KeyboardEvent, MouseEvent, SetStateAction } from "react";
import type { JobView } from "@/lib/reduce";
import type { Scenario } from "@/lib/scenario";
import { secs, ts } from "@/lib/format";
import { Frame } from "./Frames";

export function Timeline({
  sc,
  view,
  t,
  setT,
}: {
  sc: Scenario;
  view: JobView;
  t: number;
  setT: Dispatch<SetStateAction<number>>;
}) {
  const dur = Math.max(view.durationMs, 1);
  const pct = (ms: number) => Math.min(100, Math.max(0, (ms / dur) * 100));
  const cells = Math.max(1, sc.thumbs);
  const r = view.retrieval;

  const seek = (e: MouseEvent<HTMLDivElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    if (b.width <= 0) return;
    setT(Math.round(Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)) * view.durationMs));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 5000 : 1000;
    if (e.key === "ArrowRight") setT((p) => Math.min(view.durationMs, p + step));
    else if (e.key === "ArrowLeft") setT((p) => Math.max(0, p - step));
    else if (e.key === "Home") setT(0);
    else if (e.key === "End") setT(view.durationMs);
    else return;
    e.preventDefault();
  };

  const hits = view.searches.flatMap((s, si) => s.hits.map((h, hi) => ({ ...h, key: `${si}-${hi}` })));

  return (
    <div className="rounded-2xl bg-[#0b0c09] p-3 text-white ring-1 ring-black/20 sm:p-4">
      {/* tick labels */}
      <div className="relative mb-2 h-4 font-mono text-[10px] text-white/45">
        {[0, 1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={`absolute top-0 ${i === 1 || i === 3 ? "hidden sm:block" : ""}`}
            style={{ left: `${i * 25}%`, transform: i === 0 ? "none" : i === 4 ? "translateX(-100%)" : "translateX(-50%)" }}
          >
            {ts((dur * i) / 4)}
          </span>
        ))}
      </div>

      <div
        role="slider"
        tabIndex={0}
        aria-label="Timeline seek"
        aria-valuemin={0}
        aria-valuemax={view.durationMs}
        aria-valuenow={Math.round(t)}
        aria-valuetext={ts(t)}
        onClick={seek}
        onKeyDown={onKey}
        className="relative cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-lime"
        style={{ marginTop: r ? "1.5rem" : 0 }}
      >
        {/* heat lane */}
        <div className="relative mb-1.5 h-3 overflow-hidden rounded bg-white/[0.05]" aria-hidden>
          {hits.map((h) => (
            <span
              key={h.key}
              className="absolute top-0 h-full rounded-[2px] bg-lime"
              style={{
                left: `${pct(h.start_ms)}%`,
                width: `${Math.max(0.8, pct(h.end_ms) - pct(h.start_ms))}%`,
                opacity: 0.3 + 0.7 * Math.min(1, Math.max(0, h.score)),
              }}
            />
          ))}
        </div>

        {/* filmstrip */}
        <div className="flex gap-px overflow-hidden rounded-md" aria-hidden>
          {Array.from({ length: cells }, (_, i) => (
            <div key={i} className="relative aspect-[16/10] min-w-0 flex-1 overflow-hidden bg-white/[0.06]">
              {view.index ? (
                <Frame state={sc.frameAt(((i + 0.5) / cells) * view.durationMs)} />
              ) : (
                <div
                  className="grid h-full w-full place-items-center"
                  style={{ backgroundImage: "repeating-linear-gradient(135deg, rgb(255 255 255 / 0.05) 0 6px, transparent 6px 12px)" }}
                >
                  {i === Math.floor(cells / 2) && (
                    <span className="hidden whitespace-nowrap font-mono text-[9px] text-white/40 sm:block">awaiting index</span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
        {!view.index && (
          <div className="mt-1 text-center font-mono text-[9px] text-white/40 sm:hidden">awaiting index</div>
        )}

        {/* retrieval window */}
        {r && (
          <div
            className="pointer-events-none absolute -top-0 bottom-0 rounded-sm border-2 border-lime"
            style={{ left: `${pct(r.start_ms)}%`, width: `${Math.max(0.8, pct(r.end_ms) - pct(r.start_ms))}%`, bottom: view.index ? 0 : undefined }}
          >
            <span
              className="absolute bottom-full mb-1 whitespace-nowrap rounded bg-lime px-1.5 py-0.5 font-mono text-[10px] font-medium text-lime-ink"
              style={pct(r.start_ms) > 60 ? { right: 0 } : { left: 0 }}
            >
              {ts(r.start_ms)}–{ts(r.end_ms)} · {secs(r.end_ms - r.start_ms)}
            </span>
          </div>
        )}

        {/* playhead */}
        <div
          className="pointer-events-none absolute -bottom-1 -top-1 w-px bg-white shadow-[0_0_0_1px_rgb(0_0_0/0.4)]"
          style={{ left: `${pct(t)}%` }}
          aria-hidden
        />
      </div>
    </div>
  );
}
