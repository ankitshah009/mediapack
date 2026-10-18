/** MCP App view: renders a SearchResult / JobView / OperationView from tool structuredContent. */
import { ThemeProvider, useToolContext, useViewTheme } from "mcp-use/react";
import { useState } from "react";

import { AllowanceChips, FrameGrid, SearchResultBlock, normalize } from "../../app/src/components/results.js";
import { Badge, Skeleton } from "../../app/src/components/ui.js";
import "./view.css";

function Body() {
  const theme = useViewTheme();
  const ctx = useToolContext();
  const [active, setActive] = useState<string>();

  let inner;
  if (ctx.status === "pending") {
    const q = (ctx.toolInput as { query?: string } | undefined)?.query;
    inner = (
      <div aria-busy="true" role="status" className="flex flex-col gap-2">
        <p className="text-sm text-muted">{q ? `Searching “${q}”…` : "Loading result…"}</p>
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
    );
  } else if (ctx.status === "error") {
    inner = (
      <p role="alert" className="rounded-xl border border-danger/30 bg-danger-soft p-3 text-sm">
        {ctx.error.message || "The tool returned an error."}
      </p>
    );
  } else {
    const n = normalize(ctx.toolOutput);
    const hasAnything = n.search || n.artifacts.length || n.job || n.operation;
    inner = (
      <div className="flex flex-col gap-4">
        {n.job && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge tone={n.job.payment_state === "paid" ? "ok" : n.job.payment_state === "reconciling" ? "stripe" : "neutral"}>
              {n.job.payment_state === "paid" ? "Paid" : n.job.payment_state === "reconciling" ? "Payment reconciling" : "Unpaid"}
            </Badge>
            <Badge>{n.job.state.replace("_", " ")}</Badge>
            <span className="truncate text-muted">{n.job.video.file_name}</span>
          </div>
        )}
        {n.search ? (
          <SearchResultBlock result={n.search} activeId={active} onSelect={(m) => setActive(m.match_id)} />
        ) : n.operation && n.operation.state !== "succeeded" ? (
          <p role="status" className="text-sm text-muted">
            {n.operation.state === "failed"
              ? `The ${n.operation.kind.replace("_", " ")} failed: ${n.operation.error?.message ?? "no detail reported"}`
              : `Working on ${n.operation.kind.replace("_", " ")} (${n.operation.state}). Check the job again shortly.`}
          </p>
        ) : null}
        {n.artifacts.length > 0 && (
          <div>
            <p className="mb-2 text-sm font-medium">Frames</p>
            <FrameGrid artifacts={n.artifacts} />
          </div>
        )}
        {n.errorMessage && !n.search && <p role="alert" className="text-sm text-danger">{n.errorMessage}</p>}
        {!hasAnything && (
          <p className="text-sm text-muted">No search result in this response. Ask the agent to run a search on a paid job.</p>
        )}
        {n.remaining && (
          <div>
            <p className="mb-1 text-xs text-muted">Remaining allowance</p>
            <AllowanceChips remaining={n.remaining} limits={n.limits} />
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="mp-view rounded-2xl border border-line p-4" data-theme={theme === "dark" ? "dark" : "light"}>
      {inner}
    </div>
  );
}

export default function SearchResultsView() {
  return (
    <ThemeProvider>
      <Body />
    </ThemeProvider>
  );
}
