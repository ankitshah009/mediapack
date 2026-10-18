import { useEffect, useState } from "react";
import { Api, type ArtifactRef } from "../api/client";
import { FrameGrid } from "./results";
import { Badge } from "./ui";
import { range } from "../lib/format";

/** Resolve a playable URL for an artifact: use the embedded one unless expired/missing, else mint via /access. */
function useArtifactUrl(a: ArtifactRef) {
  const [url, setUrl] = useState<string | undefined>(() =>
    a.url && (!a.url_expires_at || new Date(a.url_expires_at).getTime() > Date.now() + 5000) ? a.url : undefined,
  );
  const [err, setErr] = useState(false);
  useEffect(() => {
    if (url) return;
    let live = true;
    Api.access(a.artifact_id)
      .then((r) => live && setUrl(r.url))
      .catch(() => live && setErr(true));
    return () => {
      live = false;
    };
  }, [a.artifact_id, url]);
  return { url, err };
}

function ClipItem({ a }: { a: ArtifactRef }) {
  const { url, err } = useArtifactUrl(a);
  return (
    <li className="overflow-hidden rounded-xl border border-line bg-card">
      {url ? (
        <video controls preload="metadata" src={`${url}#t=0.1`} className="aspect-video w-full bg-code" aria-label={`Exported clip ${range(a.actual_ms.start, a.actual_ms.end ?? a.actual_ms.start)}`} />
      ) : (
        <div className="grid aspect-video place-items-center bg-code text-xs text-rail-text/70">{err ? "Could not authorize this clip" : "Authorizing clip…"}</div>
      )}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
        <Badge tone="lime">Exported clip</Badge>
        <span className="font-mono">{range(a.actual_ms.start, a.actual_ms.end ?? a.actual_ms.start)}</span>
        {a.duration_ms != null && <span className="text-muted">{(a.duration_ms / 1000).toFixed(1)}s</span>}
        <span className="ml-auto font-mono text-muted" title={a.sha256}>sha {a.sha256.slice(0, 8)}</span>
      </div>
    </li>
  );
}

function FrameResolver({ frames }: { frames: ArtifactRef[] }) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    for (const f of frames) {
      const fresh = f.url && (!f.url_expires_at || new Date(f.url_expires_at).getTime() > Date.now() + 5000);
      if (fresh || urls[f.artifact_id]) continue;
      Api.access(f.artifact_id)
        .then((r) => live && setUrls((u) => ({ ...u, [f.artifact_id]: r.url })))
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frames.map((f) => f.artifact_id).join()]);
  return <FrameGrid artifacts={frames} urlFor={(a) => urls[a.artifact_id] ?? a.url} />;
}

/** Paid, exported artifacts — labeled separately from the owner's original upload. */
export function ExportedArtifacts({ artifacts }: { artifacts: ArtifactRef[] }) {
  const frames = artifacts.filter((a) => a.kind === "frame");
  const clips = artifacts.filter((a) => a.kind === "clip");
  if (!frames.length && !clips.length) return null;
  return (
    <div className="flex flex-col gap-4" aria-label="Exported from this pack">
      {frames.length > 0 && (
        <div>
          <p className="mb-2 flex items-center gap-2 text-sm font-medium">Exported frames <Badge tone="lime">{frames.length}</Badge></p>
          <FrameResolver frames={frames} />
        </div>
      )}
      {clips.length > 0 && (
        <div>
          <p className="mb-2 flex items-center gap-2 text-sm font-medium">Exported clips <Badge tone="lime">{clips.length}</Badge></p>
          <ul className="grid gap-3 sm:grid-cols-2">{clips.map((c) => <ClipItem key={c.artifact_id} a={c} />)}</ul>
        </div>
      )}
    </div>
  );
}
