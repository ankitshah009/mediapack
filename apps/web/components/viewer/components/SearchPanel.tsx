import { useState } from "react";
import { Api, ApiError, type JobView, type OperationView } from "../api/client";
import { toApiError } from "../api/hooks";
import type { SearchResult } from "../api/types";
import { requestIdFor, settleRequest } from "../lib/format";
import { ErrorPanel } from "./Shell";
import { AllowanceChips, SearchResultBlock } from "./results";
import { Badge, Button, Card, SectionTitle, Spinner } from "./ui";

type Match = SearchResult["matches"][number];

const asResult = (op: OperationView) => (op.state === "succeeded" && op.result ? (op.result as unknown as SearchResult) : undefined);

export function SearchPanel({
  job,
  activeId,
  onSelect,
  onChanged,
}: {
  job: JobView;
  activeId?: string;
  onSelect: (m: Match) => void;
  onChanged: () => void;
}) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError>();
  const ops = job.operations.filter((o) => o.kind === "search_video").reverse();
  const latestDone = ops.find((o) => asResult(o));
  const earlier = ops.filter((o) => o !== latestDone && asResult(o));
  const running = ops.filter((o) => o.state === "queued" || o.state === "dispatched" || o.state === "running");
  const failed = ops.filter((o) => o.state === "failed");

  const indexOp = job.operations.find((o) => o.kind === "index_video");
  const exhausted = job.remaining.searches <= 0;
  const gate: "pay" | "reconciling" | "indexing" | "failed" | "expired" | "open" =
    job.state === "expired" ? "expired"
    : job.state === "failed" ? "failed"
    : job.payment_state === "reconciling" ? "reconciling"
    : job.payment_state !== "paid" ? "pay"
    : job.state !== "ready" ? "indexing"
    : "open";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const query = q.trim();
    setBusy(true);
    setErr(undefined);
    const key = `search:${job.job_id}:${query}`;
    try {
      await Api.search(job.job_id, { request_id: requestIdFor(key), query, max_results: 3 });
      settleRequest(key);
      setQ("");
      onChanged();
    } catch (x) {
      setErr(toApiError(x));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card aria-labelledby="search-h">
      <SectionTitle id="search-h" aside={<AllowanceChips remaining={job.remaining} limits={job.quote.limits} />}>
        Search
      </SectionTitle>

      {gate === "open" && !exhausted && (
        <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <label htmlFor="q" className="text-sm font-medium">Ask this video a question</label>
            <input
              id="q"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              minLength={3}
              maxLength={500}
              required
              placeholder="e.g. where does the presenter show the pricing slide?"
              className="mt-1 block min-h-11 w-full rounded-xl border border-line bg-paper px-3 text-base"
            />
          </div>
          <Button type="submit" variant="primary" busy={busy} disabled={q.trim().length < 3}>
            Search · uses 1 of {job.remaining.searches}
          </Button>
        </form>
      )}

      {gate === "open" && exhausted && (
        <div role="status" className="rounded-xl border border-danger/30 bg-danger-soft p-3 text-sm">
          <p className="font-medium text-danger">Search allowance used up</p>
          <p className="mt-0.5">This pack&apos;s {job.quote.limits.searches} searches are spent. Earlier results below stay readable; a new search needs a new pack.</p>
        </div>
      )}
      {gate === "pay" && <p className="text-sm text-muted">Search opens after the quote is paid and the video is indexed.</p>}
      {gate === "reconciling" && <p role="status" className="text-sm text-stripe">Payment is reconciling. Search unlocks once Stripe confirms it.</p>}
      {gate === "indexing" && (
        <p role="status" className="flex items-center gap-2 text-sm"><Spinner /> Indexing this video. Search opens when the index is verified.</p>
      )}
      {gate === "expired" && <p role="status" className="text-sm text-danger">This pack has expired. Results already delivered remain below.</p>}
      {gate === "failed" && (
        <div role="alert" className="rounded-xl border border-danger/30 bg-danger-soft p-3 text-sm">
          <p className="font-medium text-danger">The worker failed</p>
          <p className="mt-0.5">{indexOp?.error?.message ?? job.next_action}</p>
          <p className="mt-1 text-xs text-muted">Your payment is preserved and no second pack is bought automatically. {indexOp?.error?.code && <Badge tone="danger">{indexOp.error.code}</Badge>}</p>
        </div>
      )}

      {err && <div className="mt-3"><ErrorPanel error={err} /></div>}

      {running.map((o) => (
        <p key={o.operation_id} role="status" className="mt-4 flex items-center gap-2 text-sm">
          <Spinner /> Searching “{String(o.input.query ?? "")}” <Badge tone="warn">{o.state}</Badge>
        </p>
      ))}
      {failed.map((o) => (
        <div key={o.operation_id} role="alert" className="mt-4 rounded-xl border border-danger/30 bg-danger-soft p-3 text-sm">
          <p className="font-medium text-danger">Search failed: “{String(o.input.query ?? "")}”</p>
          <p className="mt-0.5">{o.error?.message ?? "The worker did not return a result."} {o.error?.code && <Badge tone="danger">{o.error.code}</Badge>}</p>
        </div>
      ))}

      {latestDone && (
        <div className="mt-5 border-t border-line pt-4">
          <SearchResultBlock result={asResult(latestDone)!} activeId={activeId} onSelect={onSelect} />
        </div>
      )}
      {earlier.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm text-muted">Earlier searches ({earlier.length})</summary>
          <div className="mt-3 flex flex-col gap-5">
            {earlier.map((o) => (
              <SearchResultBlock key={o.operation_id} result={asResult(o)!} activeId={activeId} onSelect={onSelect} />
            ))}
          </div>
        </details>
      )}
      {ops.length === 0 && gate === "open" && !exhausted && (
        <p className="mt-4 text-sm text-muted">No searches yet. Results show matching time ranges, whether they came from what is seen or said, and the evidence behind each.</p>
      )}
    </Card>
  );
}
