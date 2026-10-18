"use client";

import { useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { SCENARIOS } from "@/lib/demo/scenarios";
import { useDemoRun } from "@/lib/demo/useDemoRun";
import { project } from "@/lib/reduce";
import type { Scenario } from "@/lib/scenario";
import { ts, usd } from "@/lib/format";
import { Shell, TopBar } from "./Shell";
import { Pipeline } from "./Pipeline";
import { AgentView } from "./AgentView";
import { QuotePanel } from "./QuotePanel";
import { Player } from "./Player";
import { Timeline } from "./Timeline";
import { EvidenceStrip } from "./EvidenceStrip";
import { SearchLog } from "./SearchLog";
import { Report } from "./Report";
import { ActivityFeed, UsageMeters, Receipt } from "./Sidebar";

type Mode = "human" | "agent";
type Id = "bug" | "talk";

function Run({
  sc,
  mode,
  onScenario,
  onMode,
  onReplay,
}: {
  sc: Scenario;
  mode: Mode;
  onScenario: (id: Id) => void;
  onMode: (m: Mode) => void;
  onReplay: () => void;
}) {
  const { events, approving, approve } = useDemoRun(sc);
  const view = project(sc.jobId, events, approving);
  const [t, setT] = useState(0);
  const [tab, setTab] = useState<"report" | "inspect">("report");
  // Jump the playhead to the retrieval window the first time it appears (adjust-state-during-render pattern).
  const [seeded, setSeeded] = useState(false);
  if (view.retrieval && !seeded) {
    setSeeded(true);
    setT(view.retrieval.start_ms);
  }

  const phase = view.phase;
  const copy = sc.copy[phase];
  const duration = view.durationMs || 0;

  const inspect = (
    <div className="flex flex-col gap-4">
      <Player sc={sc} view={view} t={t} setT={setT} />
      <Timeline sc={sc} view={view} t={t} setT={setT} />
      <EvidenceStrip sc={sc} view={view} t={t} setT={setT} />
      <SearchLog view={view} setT={setT} />
    </div>
  );

  return (
    <Shell
      top={<TopBar jobId={sc.jobId} scenarioId={sc.id} onScenario={onScenario} mode={mode} onMode={onMode} onReplay={onReplay} />}
      aside={
        <>
          <ActivityFeed view={view} />
          <UsageMeters view={view} />
          <Receipt view={view} />
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <header key={phase} className="animate-rise flex flex-col gap-3">
          <p className="font-mono text-xs uppercase tracking-widest text-muted">
            JOB {sc.jobId} · {phase.toUpperCase()}
          </p>
          <h1 className="font-display text-4xl md:text-6xl tracking-tight text-balance">{copy.title}</h1>
          <p className="max-w-2xl text-lg text-muted">{copy.sub}</p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 font-mono text-xs text-muted">
            <span>{view.sourceName ?? "—"}</span>
            {duration > 0 && <span>· {ts(duration)}</span>}
            {view.payment && (
              <span className="inline-flex items-center gap-1 rounded-full bg-lime px-2 py-0.5 text-lime-ink">
                <CheckCircle2 size={12} aria-hidden /> Test payment confirmed · {usd(view.payment.amount_cents)}
              </span>
            )}
          </div>
        </header>

        <Pipeline view={view} />

        {mode === "agent" ? (
          <AgentView view={view} />
        ) : phase === "quoted" || phase === "paying" ? (
          <QuotePanel sc={sc} view={view} onApprove={approve} />
        ) : phase === "delivered" ? (
          <div className="flex flex-col gap-4">
            <div role="tablist" aria-label="Result view" className="inline-flex self-start rounded-full border border-line bg-card p-1 text-sm">
              {(["report", "inspect"] as const).map((k) => (
                <button
                  key={k}
                  role="tab"
                  aria-selected={tab === k}
                  onClick={() => setTab(k)}
                  className={`rounded-full px-4 py-1.5 capitalize transition-colors ${tab === k ? "bg-rail text-white" : "text-muted hover:text-current"}`}
                >
                  {k}
                </button>
              ))}
            </div>
            {tab === "report" ? <Report sc={sc} view={view} t={t} setT={setT} /> : inspect}
          </div>
        ) : (
          inspect
        )}
      </div>
    </Shell>
  );
}

export function RunConsole() {
  const [scenarioId, setScenarioId] = useState<Id>("bug");
  const [mode, setMode] = useState<Mode>("human");
  const [runKey, setRunKey] = useState(0);
  return (
    <Run
      key={scenarioId + runKey}
      sc={SCENARIOS[scenarioId]}
      mode={mode}
      onScenario={setScenarioId}
      onMode={setMode}
      onReplay={() => setRunKey((k) => k + 1)}
    />
  );
}
