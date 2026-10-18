"use client";

import type { ReactNode } from "react";
import { Braces, Eye, FileCode, FolderOpen, ListVideo, Plus, RotateCcw } from "lucide-react";

function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <rect x="2" y="2" width="14" height="14" rx="3" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <rect x="8" y="8" width="14" height="14" rx="3" fill="#d4f25a" />
    </svg>
  );
}

const NAV: { label: string; icon: typeof Plus; active?: boolean }[] = [
  { label: "New job", icon: Plus },
  { label: "Runs", icon: ListVideo, active: true },
  { label: "Results", icon: FolderOpen },
  { label: "Agent docs", icon: FileCode },
];

function Rail() {
  return (
    <nav
      aria-label="Primary"
      className="hidden md:flex w-16 shrink-0 flex-col items-center gap-2 bg-rail py-4 text-rail-text"
    >
      <div className="mb-4 grid h-10 w-10 place-items-center text-rail-text">
        <LogoMark className="h-7 w-7" />
      </div>
      <ul className="flex flex-1 flex-col items-center gap-1">
        {NAV.map(({ label, icon: Icon, active }) => (
          <li key={label} className="group relative">
            <button
              type="button"
              aria-label={label}
              aria-current={active ? "page" : undefined}
              className={`relative grid h-10 w-10 place-items-center rounded-xl transition-colors focus-visible:outline-2 focus-visible:outline-lime ${
                active ? "bg-white/10 text-white" : "text-rail-text/60 hover:bg-white/5 hover:text-white"
              }`}
            >
              {active && <span className="absolute -left-3 top-2 h-6 w-[3px] rounded-r bg-lime" />}
              <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
            </button>
            <span
              role="tooltip"
              className="pointer-events-none absolute left-full top-1/2 z-50 ml-3 -translate-y-1/2 whitespace-nowrap rounded-md bg-ink px-2 py-1 text-xs text-white opacity-0 shadow-lg ring-1 ring-white/10 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
            >
              {label}
            </span>
          </li>
        ))}
      </ul>
      <div
        title="Workspace"
        className="grid h-9 w-9 place-items-center rounded-full bg-white/10 font-mono text-[11px] font-medium text-white"
      >
        HW
      </div>
    </nav>
  );
}

export function Shell({ top, children, aside }: { top: ReactNode; children: ReactNode; aside: ReactNode }) {
  return (
    <div className="flex min-h-dvh bg-paper text-text md:h-dvh md:overflow-hidden">
      <Rail />
      <div className="flex min-w-0 flex-1 flex-col">
        {top}
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px]">
          <main className="min-w-0 px-4 py-5 sm:px-6 lg:overflow-y-auto lg:px-8 lg:py-7">
            <div className="mx-auto flex max-w-5xl flex-col gap-6">
              {children}
              <p className="pt-2 text-xs text-muted">
                Prototype · simulated event stream. Production renders the same events from Supabase Realtime.
              </p>
            </div>
          </main>
          <aside
            aria-label="Activity and billing"
            className="min-w-0 border-t border-line px-4 py-5 sm:px-6 lg:overflow-y-auto lg:border-l lg:border-t-0 lg:px-5 lg:py-7"
          >
            <div className="flex flex-col gap-6">{aside}</div>
          </aside>
        </div>
      </div>
    </div>
  );
}

function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { id: T; text: string; icon?: typeof Eye }[];
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg bg-white/10 p-0.5">
      {options.map(({ id, text, icon: Icon }) => {
        const on = id === value;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={text}
            title={text}
            onClick={() => onChange(id)}
            className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-lime sm:px-2.5 ${
              on ? "bg-lime text-lime-ink" : "text-rail-text/70 hover:text-white"
            }`}
          >
            {Icon && <Icon className="h-3.5 w-3.5" aria-hidden="true" />}
            <span className={Icon ? "hidden sm:inline" : ""}>{Icon ? text : text}</span>
          </button>
        );
      })}
    </div>
  );
}

export function TopBar({
  jobId,
  scenarioId,
  onScenario,
  mode,
  onMode,
  onReplay,
}: {
  jobId: string;
  scenarioId: "bug" | "talk";
  onScenario: (id: "bug" | "talk") => void;
  mode: "human" | "agent";
  onMode: (m: "human" | "agent") => void;
  onReplay: () => void;
}) {
  return (
    <header className="sticky top-0 z-40 flex flex-wrap items-center gap-x-3 gap-y-2 bg-rail px-3 py-2.5 text-rail-text sm:px-5 md:static">
      <div className="flex items-center gap-2 md:hidden">
        <LogoMark className="h-6 w-6 text-rail-text" />
      </div>
      <div className="flex min-w-0 flex-col leading-tight">
        <span className="font-display text-sm font-semibold tracking-tight text-white">MediaPack</span>
        <span className="hidden text-[11px] text-rail-text/60 sm:block">Video search for agents</span>
      </div>
      <div className="hidden min-w-0 items-center gap-1 border-l border-white/10 pl-3 font-mono text-xs text-rail-text/60 lg:flex">
        <span>Runs</span>
        <span aria-hidden="true">/</span>
        <span className="truncate text-white">{jobId}</span>
      </div>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        <Segmented
          label="Scenario"
          value={scenarioId}
          onChange={onScenario}
          options={[
            { id: "bug", text: "Bug recording" },
            { id: "talk", text: "Kickoff talk" },
          ]}
        />
        <Segmented
          label="View"
          value={mode}
          onChange={onMode}
          options={[
            { id: "human", text: "Human", icon: Eye },
            { id: "agent", text: "Agent", icon: Braces },
          ]}
        />
        <button
          type="button"
          onClick={onReplay}
          aria-label="Replay"
          title="Replay"
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-white/10 px-2.5 text-xs font-medium text-white transition-colors hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-lime"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="hidden sm:inline">Replay</span>
        </button>
        <span className="hidden items-center gap-1.5 rounded-full bg-stripe/20 px-2.5 py-1 text-[11px] font-medium text-[#b9b4ff] xl:inline-flex">
          <span className="h-1.5 w-1.5 rounded-full bg-stripe" aria-hidden="true" />
          Stripe test mode
        </span>
      </div>
    </header>
  );
}
