# Console component contract

All components are client components (`"use client"`), default-free named exports, Tailwind v4 using
tokens in `app/globals.css` (`bg-paper bg-card text-muted border-line bg-rail bg-lime text-lime-ink
text-stripe text-primitive text-worker bg-code font-display font-mono`). Icons: `lucide-react`.
Data types: `lib/types.ts`, `lib/reduce.ts` (`JobView`, `Phase`, `STEPS`), `lib/scenario.ts`, helpers `lib/format.ts`.
Must work in light + dark and at 375px width.

| File | Exports & props | Owner |
|---|---|---|
| `Frames.tsx` | `Frame({ state: FrameState, className? })` — scales via container query units (`cqw`); fills parent, aspect set by parent | A |
| `Player.tsx` | `Player({ sc: Scenario, view: JobView, t: number, setT: Dispatch<SetStateAction<number>>, compact?: boolean })` | A |
| `Timeline.tsx` | `Timeline({ sc, view, t, setT })` — ticks, search-hit heat marks, filmstrip (skeleton until `view.index`), retrieval window, playhead, click-to-seek | A |
| `EvidenceStrip.tsx` | `EvidenceStrip({ sc, view, setT })` — frames at `view.retrieval.frames_ms` | A |
| `QuotePanel.tsx` | `QuotePanel({ sc, view, onApprove: () => void })` — phases quoted/paying | B |
| `SearchLog.tsx` | `SearchLog({ view, setT })` — agent `search_video` calls + ranked hits | B |
| `Report.tsx` | `Report({ sc, view, t, setT })` — uses `Player` (compact) + `Frame`; findings clickable | B |
| `Shell.tsx` | `Shell({ children, aside, top })` layout with dark rail; `TopBar({ jobId, scenarioId, onScenario, mode, onMode, onReplay })` | C |
| `Pipeline.tsx` | `Pipeline({ view })` — 6 steps from `STEPS` with provider labels + relative times | C |
| `Sidebar.tsx` | `ActivityFeed({ view })`, `UsageMeters({ view })`, `Receipt({ view })` | C |
| `AgentView.tsx` | `AgentView({ view })` — JSON the agent sees (`get_job` response shape) | C |
| `lib/demo/scenarios.ts`, `lib/demo/useDemoRun.ts`, `RunConsole.tsx`, `app/page.tsx` | composition + simulated event replay | D |
