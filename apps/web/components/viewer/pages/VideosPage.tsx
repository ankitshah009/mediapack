"use client";

import { useState } from "react";
import { Api, type VideoView } from "../api/client";
import { usePoll } from "../api/hooks";
import { ErrorPanel, Link, Shell } from "../components/Shell";
import { Uploader } from "../components/Uploader";
import { VideoMemoryExplainer } from "../components/VideoMemoryExplainer";
import { Badge, Card, Empty, Skeleton } from "../components/ui";
import { bytes, dur } from "../lib/format";

export function stateBadge(v: VideoView["state"]) {
  const map = {
    uploading: ["warn", "Uploading"],
    probing: ["warn", "Verifying"],
    ready: ["ok", "Ready"],
    rejected: ["danger", "Rejected"],
    expired: ["neutral", "Expired"],
  } as const;
  const [tone, label] = map[v];
  return <Badge tone={tone}>{label}</Badge>;
}

export function VideosPage() {
  const [session, setSession] = useState(0);
  const list = usePoll(() => Api.videos(), (v) => v.some((x) => x.state === "uploading" || x.state === "probing"), [session]);
  return (
    <Shell crumb={<span>Videos</span>}>
      <h1 className="sr-only">Videos</h1>
      <Uploader onUploaded={list.reload} onSession={() => setSession((s) => s + 1)} />
      <section aria-labelledby="your-videos">
        <h2 id="your-videos" className="mb-3 font-display text-base font-semibold tracking-tight">
          Your videos
        </h2>
        {list.loading && !list.data ? (
          <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading videos">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        ) : list.error && !list.data ? (
          <ErrorPanel error={list.error} onRetry={list.reload} onSession={() => setSession((s) => s + 1)} />
        ) : list.data && list.data.length === 0 ? (
          <Empty title="No videos yet">Upload an MP4 or WebM above. Once verified you can request a quote and ask questions of it.</Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {list.data?.map((v) => (
              <li key={v.video_id}>
                <Card className="!p-3 sm:!p-4">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <Link to={`/v/${v.video_id}`} className="min-w-0 flex-1 truncate font-medium hover:underline">
                      {v.file_name}
                    </Link>
                    {stateBadge(v.state)}
                    {v.latest_job_id && (
                      <Link to={`/jobs/${v.latest_job_id}`} className="rounded-lg bg-lime px-2.5 py-1 text-xs font-medium text-lime-ink">
                        Open job
                      </Link>
                    )}
                  </div>
                  <p className="mt-1 font-mono text-xs text-muted">
                    {v.state === "rejected" && v.reject
                      ? v.reject.message
                      : [
                          v.duration_ms != null ? dur(v.duration_ms) : null,
                          v.width && v.height ? `${v.width}×${v.height}` : null,
                          v.audio !== "unknown" ? (v.audio === "present" ? "audio" : "no audio") : null,
                          bytes(v.size_bytes),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                  </p>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
      <VideoMemoryExplainer />
    </Shell>
  );
}
