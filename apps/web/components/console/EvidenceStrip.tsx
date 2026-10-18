"use client";

import type { Dispatch, SetStateAction } from "react";
import type { JobView } from "@/lib/reduce";
import type { Scenario } from "@/lib/scenario";
import { secs, ts } from "@/lib/format";
import { Frame } from "./Frames";

export function EvidenceStrip({
  sc,
  view,
  t,
  setT,
}: {
  sc: Scenario;
  view: JobView;
  /** Optional current time, used to highlight the nearest frame. */
  t?: number;
  setT: Dispatch<SetStateAction<number>>;
}) {
  const r = view.retrieval;
  if (!r) return null;

  let nearest = -1;
  if (t !== undefined) {
    let best = Infinity;
    r.frames_ms.forEach((f, i) => {
      const d = Math.abs(f - t);
      if (d < best) {
        best = d;
        nearest = i;
      }
    });
  }

  return (
    <section aria-label="Evidence selected by the agent" className="rounded-2xl border border-line bg-card p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="font-display text-sm font-semibold tracking-tight">Selected by the agent</h3>
        <span className="font-mono text-xs text-muted">
          {r.frames_ms.length} frames · {secs(r.clip_ms)} clip
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2 sm:gap-3 md:grid-cols-6">
        {r.frames_ms.map((f, i) => (
          <button
            key={f}
            type="button"
            aria-label={`Seek to ${ts(f)}`}
            onClick={() => setT(f)}
            className={`animate-rise group relative aspect-[16/10] overflow-hidden rounded-xl outline-none ring-1 transition focus-visible:ring-2 focus-visible:ring-lime ${
              i === nearest ? "ring-2 ring-lime" : "ring-line hover:ring-2 hover:ring-lime/60"
            }`}
            style={{ animationDelay: `${i * 70}ms` }}
          >
            <Frame state={sc.frameAt(f)} />
            <span className="absolute bottom-1.5 left-1.5 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-white">
              {ts(f)}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
