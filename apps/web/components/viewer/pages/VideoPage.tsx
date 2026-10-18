"use client";

import { useState } from "react";
import { Api } from "../api/client";
import { toApiError, usePoll } from "../api/hooks";
import { ErrorPanel, Link, Shell } from "../components/Shell";
import { Badge, Button, Card, Mono, Skeleton, Spinner } from "../components/ui";
import { bytes, dur, requestIdFor, settleRequest } from "../lib/format";
import { useNavigate } from "../lib/router";
import { INPUT } from "../lib/limits";
import { stateBadge } from "./VideosPage";

export function VideoPage({ videoId }: { videoId: string }) {
  const navigate = useNavigate();
  const [session, setSession] = useState(0);
  const video = usePoll((s) => Api.video(videoId, s), (v) => v.state === "uploading" || v.state === "probing", [videoId, session]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ReturnType<typeof toApiError>>();
  const v = video.data;

  async function quote() {
    setBusy(true);
    setErr(undefined);
    const key = `quote:${videoId}`;
    try {
      const q = await Api.quote(videoId, requestIdFor(key));
      settleRequest(key);
      navigate(`/jobs/${q.job_id}`);
    } catch (e) {
      setErr(toApiError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell crumb={<><Link to="/" className="hover:text-white">Videos</Link><span aria-hidden="true">/</span><span className="truncate text-white">{v?.file_name ?? videoId.slice(0, 8)}</span></>}>
      {!v ? (
        video.error ? (
          <ErrorPanel error={video.error} onRetry={video.reload} onSession={() => setSession((s) => s + 1)} />
        ) : (
          <div aria-busy="true" aria-label="Loading video" className="flex flex-col gap-3"><Skeleton className="h-10 w-1/2" /><Skeleton className="h-40" /></div>
        )
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="min-w-0 truncate font-display text-2xl font-semibold tracking-tight">{v.file_name}</h1>
            {stateBadge(v.state)}
          </div>

          {(v.state === "uploading" || v.state === "probing") && (
            <Card role="status">
              <p className="flex items-center gap-2 text-sm"><Spinner /> {v.state === "uploading" ? "Waiting for the upload to finish." : "Verifying the file: checksum, streams, duration and dimensions."}</p>
              <p className="mt-1 text-xs text-muted">This page updates on its own. It cannot be bought until verification passes.</p>
            </Card>
          )}

          {v.state === "rejected" && (
            <div role="alert" className="rounded-2xl border border-danger/30 bg-danger-soft p-4">
              <h2 className="font-display text-base font-semibold text-danger">This video was rejected</h2>
              <p className="mt-1 text-sm">{v.reject?.message ?? "The file did not pass verification."} {v.reject && <Badge tone="danger">{v.reject.code}</Badge>}</p>
              <p className="mt-2 text-sm text-muted">Limits: MP4 or WebM, up to {bytes(INPUT.maxBytes)}, {dur(INPUT.maxDurationMs)} long, {INPUT.maxLongEdge}×{INPUT.maxShortEdge}. Rejected media is never purchasable.</p>
              <Link to="/" className="mt-3 inline-flex min-h-10 items-center rounded-xl bg-lime px-4 text-sm font-medium text-lime-ink">Upload another</Link>
            </div>
          )}

          {v.state === "expired" && <div role="status" className="rounded-2xl border border-line p-4 text-sm text-muted">This upload expired and its source file is no longer retained.</div>}

          {(v.state === "ready" || v.size_bytes != null) && (
            <Card aria-labelledby="meta-h">
              <h2 id="meta-h" className="mb-3 font-display text-base font-semibold">Verified metadata</h2>
              <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div><dt className="text-xs text-muted">Duration</dt><dd className="font-mono">{dur(v.duration_ms)}</dd></div>
                <div><dt className="text-xs text-muted">Dimensions</dt><dd className="font-mono">{v.width && v.height ? `${v.width}×${v.height}` : "—"}</dd></div>
                <div><dt className="text-xs text-muted">Audio</dt><dd>{v.audio === "unknown" ? "—" : v.audio === "present" ? "Present" : "None (visual search only)"}</dd></div>
                <div><dt className="text-xs text-muted">Size</dt><dd className="font-mono">{bytes(v.size_bytes)}</dd></div>
              </dl>
              {v.sha256 && <p className="mt-3 text-xs text-muted">SHA-256 <Mono>{v.sha256}</Mono></p>}
            </Card>
          )}

          {v.state === "ready" && (
            <Card>
              <h2 className="font-display text-base font-semibold">Search this video</h2>
              <p className="mt-1 text-sm text-muted">A quote fixes the price and allowance for this exact file. Nothing is charged until the agent pays it over Stripe MPP.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {v.latest_job_id ? (
                  <Link to={`/jobs/${v.latest_job_id}`} className="inline-flex min-h-10 items-center rounded-xl bg-lime px-4 text-sm font-medium text-lime-ink">Open job</Link>
                ) : null}
                <Button variant={v.latest_job_id ? "secondary" : "primary"} busy={busy} onClick={quote}>
                  {v.latest_job_id ? "Request a new quote" : "Get a quote"}
                </Button>
              </div>
              {err && <div className="mt-3"><ErrorPanel error={err} /></div>}
            </Card>
          )}
        </>
      )}
    </Shell>
  );
}
