"use client";

import { useEffect, useState, type Dispatch, type KeyboardEvent, type MouseEvent, type SetStateAction } from "react";
import { Lock, Maximize2, Pause, Play, Volume2, VolumeX } from "lucide-react";
import type { JobView } from "@/lib/reduce";
import type { Scenario } from "@/lib/scenario";
import { ts } from "@/lib/format";
import { Frame } from "./Frames";

export function Player({
  sc,
  view,
  t,
  setT,
  compact,
}: {
  sc: Scenario;
  view: JobView;
  t: number;
  setT: Dispatch<SetStateAction<number>>;
  compact?: boolean;
}) {
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const dur = Math.max(view.durationMs, 1);
  const lo = view.retrieval?.start_ms ?? 0;
  const hi = view.retrieval?.end_ms ?? view.durationMs;

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setT((p) => {
        const n = p + 500;
        return p < lo || n > hi ? lo : n;
      });
    }, 250);
    return () => clearInterval(id);
  }, [playing, lo, hi, setT]);

  const seek = (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width <= 0) return;
    setT(Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * view.durationMs));
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

  const locked = view.phase === "quoted" || view.phase === "paying" || view.phase === "processing";
  const indexing = view.phase === "indexing";
  const pct = Math.round(view.progress?.pct ?? 0);
  const icon = compact ? 14 : 16;
  const btn = "grid place-items-center rounded-md text-white/80 outline-none transition hover:text-white focus-visible:ring-2 focus-visible:ring-lime";

  return (
    <div className="overflow-hidden rounded-2xl bg-[#0b0c09] ring-1 ring-black/20">
      <div className="relative aspect-[16/10] w-full bg-black">
        <Frame state={sc.frameAt(t)} />
        <span className="absolute right-3 top-3 rounded-full bg-black/55 px-2.5 py-1 text-[10px] font-medium tracking-wide text-white/80 backdrop-blur">
          Source recording
        </span>
        {locked && (
          <div className="absolute inset-0 grid place-items-center bg-black/45 backdrop-blur-[1px]">
            <span className="inline-flex items-center gap-2 rounded-full bg-black/70 px-3.5 py-1.5 text-xs font-medium text-white ring-1 ring-white/15">
              <Lock size={13} aria-hidden /> Index unlocks after payment
            </span>
          </div>
        )}
        {indexing && (
          <>
            <div className="animate-shimmer absolute inset-0" aria-hidden />
            <div className="absolute bottom-3 left-3 w-[min(16rem,calc(100%-1.5rem))] rounded-xl bg-black/70 px-3 py-2 text-white ring-1 ring-white/15 backdrop-blur">
              <div className="text-xs font-medium">
                Indexing · {view.progress?.stage ?? "probe"} {pct}%
              </div>
              <div className="mt-1.5 h-0.5 overflow-hidden rounded-full bg-white/15">
                <div className="h-full rounded-full bg-lime transition-[width] duration-300" style={{ width: `${pct}%` }} />
              </div>
            </div>
          </>
        )}
      </div>
      <div className={`flex items-center gap-3 bg-[#11120e] ${compact ? "px-3 py-2" : "px-4 py-3"}`}>
        <button type="button" aria-label={playing ? "Pause" : "Play"} onClick={() => setPlaying((p) => !p)} className={`${btn} h-7 w-7`}>
          {playing ? <Pause size={icon} fill="currentColor" /> : <Play size={icon} fill="currentColor" />}
        </button>
        <button type="button" aria-label={muted ? "Unmute" : "Mute"} onClick={() => setMuted((m) => !m)} className={`${btn} h-7 w-7`}>
          {muted ? <VolumeX size={icon} /> : <Volume2 size={icon} />}
        </button>
        <span className={`font-mono tabular-nums text-white/70 ${compact ? "text-[10px]" : "text-xs"}`}>
          {ts(t)} / {ts(view.durationMs)}
        </span>
        <div
          role="slider"
          tabIndex={0}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={view.durationMs}
          aria-valuenow={Math.round(t)}
          aria-valuetext={ts(t)}
          onClick={seek}
          onKeyDown={onKey}
          className="group relative flex h-5 flex-1 cursor-pointer items-center outline-none"
        >
          <div className="h-1 w-full overflow-hidden rounded-full bg-white/15 group-focus-visible:ring-2 group-focus-visible:ring-lime">
            <div className="h-full rounded-full bg-lime" style={{ width: `${Math.min(100, (t / dur) * 100)}%` }} />
          </div>
        </div>
        <button
          type="button"
          aria-label="Fullscreen"
          onClick={() => void document.documentElement.requestFullscreen?.().catch(() => undefined)}
          className={`${btn} h-7 w-7`}
        >
          <Maximize2 size={icon - 2} />
        </button>
      </div>
    </div>
  );
}
