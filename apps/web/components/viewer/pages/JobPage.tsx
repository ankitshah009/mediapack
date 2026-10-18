"use client";

import { useState } from "react";
import { Api } from "../api/client";
import { toApiError, useJob } from "../api/hooks";
import { ActivityFeed } from "../components/Activity";
import { ExportedArtifacts } from "../components/ArtifactMedia";
import { AllowanceMeters, ReceiptPanel } from "../components/PackPanel";
import { PaymentStateBadge, QuotePanel } from "../components/QuotePanel";
import { SearchPanel } from "../components/SearchPanel";
import { ErrorPanel, Link, Shell } from "../components/Shell";
import { SourceInspector } from "../components/SourceInspector";
import { Badge, Card, SectionTitle, Skeleton } from "../components/ui";
import { normalize } from "../components/results";
import { readableError, requestIdFor, settleRequest } from "../lib/format";
import { useNavigate } from "../lib/router";

export function JobPage({ jobId }: { jobId: string }) {
  const navigate = useNavigate();
  const [session, setSession] = useState(0);
  const { job, events, evError } = useJob(jobId, session);
  const [activeId, setActiveId] = useState<string>();
  const [quoting, setQuoting] = useState(false);
  const [qErr, setQErr] = useState<ReturnType<typeof toApiError>>();
  const j = job.data;

  if (!j) {
    return (
      <Shell crumb={<span>Job / {jobId.slice(0, 8)}</span>}>
        {job.error ? (
          <ErrorPanel error={job.error} onRetry={job.reload} onSession={() => { setSession((s) => s + 1); }} />
        ) : (
          <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading job">
            <Skeleton className="h-10 w-2/3" /><Skeleton className="h-40" /><Skeleton className="h-64" />
          </div>
        )}
      </Shell>
    );
  }

  const n = normalize(j);
  const matches = n.search?.matches ?? [];
  const failedOps = j.operations.filter((o) => o.state === "failed" && o.kind !== "search_video");

  async function newQuote() {
    setQuoting(true);
    setQErr(undefined);
    const key = `quote:${j!.video.video_id}:${j!.quote.quote_id}`;
    try {
      const q = await Api.quote(j!.video.video_id, requestIdFor(key));
      settleRequest(key);
      navigate(`/jobs/${q.job_id}`);
    } catch (e) {
      setQErr(toApiError(e));
    } finally {
      setQuoting(false);
    }
  }

  return (
    <Shell
      crumb={<><Link to="/" className="hover:text-white">Videos</Link><span aria-hidden="true">/</span><span className="truncate text-white">{j.video.file_name}</span></>}
      badges={<Badge tone="stripe">Stripe {j.quote.payment_mode}</Badge>}
      aside={
        <>
          <Card aria-labelledby="act-h">
            <SectionTitle id="act-h" aside={job.error ? <Badge tone="danger">Offline, retrying</Badge> : undefined}>Activity</SectionTitle>
            <ActivityFeed events={events} operations={j.operations} error={evError?.message} />
          </Card>
          <AllowanceMeters job={j} />
          <ReceiptPanel job={j} />
        </>
      }
    >
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="min-w-0 truncate font-display text-2xl font-semibold tracking-tight">{j.video.file_name}</h1>
          <PaymentStateBadge job={j} />
          <Badge tone={j.state === "ready" ? "ok" : j.state === "failed" ? "danger" : j.state === "expired" ? "neutral" : "warn"}>{j.state.replace("_", " ")}</Badge>
        </div>
        <p className="mt-1 wrap-anywhere text-sm text-muted" role="status">{j.next_action}</p>
        {job.error && <div className="mt-3"><ErrorPanel error={job.error} onRetry={job.reload} /></div>}
      </div>

      {(j.payment_state !== "paid" || j.state === "awaiting_payment") && <QuotePanel job={j} onNewQuote={newQuote} busy={quoting} />}
      {qErr && <ErrorPanel error={qErr} />}

      {failedOps.map((o) => (
        <div key={o.operation_id} role="alert" className="rounded-2xl border border-danger/30 bg-danger-soft p-4 text-sm">
          <p className="font-medium text-danger">Worker failed: {o.kind.replace("_", " ")}</p>
          <p className="mt-0.5">{readableError(o.error?.message)} {o.error && <Badge tone="danger">{o.error.code}</Badge>}</p>
          <p className="mt-1 text-xs text-muted">Spent allowance is preserved. Nothing is re-bought automatically.</p>
        </div>
      ))}

      <SearchPanel job={j} activeId={activeId} onSelect={(m) => setActiveId(m.match_id)} onChanged={job.reload} />
      <SourceInspector job={j} matches={matches} activeMatchId={activeId} onSelectMatch={(m) => setActiveId(m.match_id)} onChanged={job.reload} />

      {n.artifacts.length > 0 && (
        <Card aria-labelledby="exp-h">
          <SectionTitle id="exp-h" aside={<Badge tone="lime">Paid exports</Badge>}>Exported from this pack</SectionTitle>
          <ExportedArtifacts artifacts={n.artifacts} />
        </Card>
      )}
    </Shell>
  );
}
