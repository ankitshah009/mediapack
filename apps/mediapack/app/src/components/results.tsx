// Shared by the standalone app and the MCP App view (views/search-results). Keep imports `.js`-suffixed and free of
// Vite-only APIs so both the app bundler and mcp-use's NodeNext typecheck resolve it.
import type { ArtifactRef, JobView, Limits, OperationView, SearchResult } from "../api/types.js";
import { mmss, range, seconds } from "../lib/format.js";
import { Badge } from "./ui.js";

type Match = SearchResult["matches"][number];

export interface Normalized {
  search?: SearchResult;
  job?: JobView;
  artifacts: ArtifactRef[];
  remaining?: Limits;
  limits?: Limits;
  operation?: OperationView;
  errorMessage?: string;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Accept a SearchResult, JobView, OperationView, or a wrapper of those (tool structuredContent shapes vary). */
export function normalize(raw: unknown): Normalized {
  const out: Normalized = { artifacts: [] };
  if (!isObj(raw)) return out;
  const take = (v: unknown) => {
    if (!isObj(v)) return;
    if (Array.isArray(v.matches) && typeof v.query === "string") out.search = v as unknown as SearchResult;
    if (typeof v.job_id === "string" && isObj(v.quote) && Array.isArray(v.operations)) {
      const job = v as unknown as JobView;
      out.job = job;
      out.remaining = job.remaining;
      out.limits = job.quote.limits;
      const ops = [...job.operations].reverse();
      const s = ops.find((o) => o.kind === "search_video" && o.state === "succeeded" && o.result);
      if (s && !out.search) take(s.result);
      for (const o of job.operations) {
        if (o.state === "succeeded" && isObj(o.result) && Array.isArray(o.result.artifacts)) {
          out.artifacts.push(...(o.result.artifacts as ArtifactRef[]));
        }
      }
    }
    if (typeof v.operation_id === "string" && typeof v.kind === "string" && "state" in v) {
      const op = v as unknown as OperationView;
      out.operation = op;
      if (op.error) out.errorMessage = op.error.message;
      if (isObj(op.result)) {
        take(op.result);
        if (Array.isArray(op.result.artifacts)) out.artifacts.push(...(op.result.artifacts as ArtifactRef[]));
      }
    }
    if (Array.isArray(v.artifacts) && !("operation_id" in v)) out.artifacts.push(...(v.artifacts as ArtifactRef[]));
    if (Array.isArray(v.frames)) out.artifacts.push(...(v.frames as ArtifactRef[]));
    for (const k of ["search", "result", "job", "operation"]) if (isObj(v[k]) && v[k] !== v) take(v[k]);
    if (isObj(v.remaining) && !out.remaining) out.remaining = v.remaining as unknown as Limits;
  };
  take(raw);
  const seen = new Set<string>();
  out.artifacts = out.artifacts.filter((a) => a && !seen.has(a.artifact_id) && !!seen.add(a.artifact_id));
  if (isObj(raw.error) && typeof raw.error.message === "string") out.errorMessage = raw.error.message;
  return out;
}

export function AllowanceChips({ remaining, limits }: { remaining: Limits; limits?: Limits }) {
  const items: { k: string; text: string }[] = [
    { k: "searches", text: `${remaining.searches}${limits ? `/${limits.searches}` : ""} searches` },
    { k: "frames", text: `${remaining.frames}${limits ? `/${limits.frames}` : ""} frames` },
    { k: "clip", text: `${seconds(remaining.clip_ms)}${limits ? `/${seconds(limits.clip_ms)}` : ""} clip` },
    { k: "text", text: `${remaining.text_chars.toLocaleString()} chars` },
  ];
  const full = `Remaining in this pack: ${items.map((i) => i.text).join(", ")}`;
  return (
    <ul aria-label="Remaining allowance" title={full} className="flex flex-wrap gap-1.5">
      {items.map((i) => (
        <li key={i.k}>
          <Badge tone={/^0\b|^0s/.test(i.text) ? "danger" : "neutral"}>{i.text}</Badge>
        </li>
      ))}
    </ul>
  );
}

export function CoverageNote({ coverage }: { coverage: SearchResult["coverage"] }) {
  const audio = coverage.audio === "available" ? "Speech indexed" : coverage.audio === "absent" ? "No audio track" : "Transcription failed";
  const detail = [
    `Visual sampling every ${seconds(coverage.visual_sample_interval_ms)}`,
    ...coverage.limitations,
  ].join(" · ");
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted" title={detail}>
      <Badge tone={coverage.audio === "failed" ? "danger" : "neutral"}>{audio}</Badge>
      <Badge>Visual every {seconds(coverage.visual_sample_interval_ms)}</Badge>
      {coverage.limitations.length > 0 && (
        <span className="min-w-0" tabIndex={0}>
          <span className="sr-only">Limitations: </span>
          {coverage.limitations.join(" · ")}
        </span>
      )}
    </p>
  );
}

export function MatchCard({
  m,
  index,
  active,
  onSelect,
}: {
  m: Match;
  index: number;
  active?: boolean;
  onSelect?: (m: Match) => void;
}) {
  const body = (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-medium">{range(m.start_ms, m.end_ms)}</span>
        {m.modalities.map((mod) => (
          <Badge key={mod} tone={mod === "speech" ? "primitive" : "stripe"}>
            {mod === "speech" ? "Speech" : "Visual"}
          </Badge>
        ))}
        <Badge tone={m.evidence_status === "supported" ? "ok" : "warn"} title={m.evidence_status === "supported" ? "Evidence directly supports the match" : "Evidence only partly supports the match"}>
          {m.evidence_status === "supported" ? "Supported" : "Partial evidence"}
        </Badge>
        <span className="ml-auto text-xs text-muted">#{index + 1}</span>
      </div>
      <p className="mt-2 text-sm leading-relaxed">{m.description}</p>
      {m.transcript_excerpt && (
        <blockquote className="mt-2 border-l-2 border-primitive pl-3 text-sm italic text-muted">“{m.transcript_excerpt}”</blockquote>
      )}
    </>
  );
  const cls = `block w-full rounded-xl border p-3 text-left ${active ? "border-stripe bg-stripe-soft" : "border-line bg-card"}`;
  return onSelect ? (
    <button type="button" aria-pressed={!!active} onClick={() => onSelect(m)} className={`${cls} hover:border-stripe`}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function FrameGrid({
  artifacts,
  urlFor,
}: {
  artifacts: ArtifactRef[];
  urlFor?: (a: ArtifactRef) => string | undefined;
}) {
  const frames = artifacts.filter((a) => a.kind === "frame");
  if (frames.length === 0) return null;
  return (
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label="Delivered frames">
      {frames.map((a) => {
        const src = urlFor?.(a) ?? a.url;
        const t = mmss(a.actual_ms.start);
        return (
          <li key={a.artifact_id} className="overflow-hidden rounded-lg border border-line bg-card">
            {src ? (
              <img src={src} alt={`Source frame at ${t}`} loading="lazy" className="aspect-video w-full bg-code object-cover" />
            ) : (
              <div className="grid aspect-video place-items-center bg-code px-2 text-center text-[11px] text-rail-text/70">
                Link not minted yet
              </div>
            )}
            <div className="flex items-center justify-between px-2 py-1 text-xs">
              <span className="font-mono">{t}</span>
              {a.actual_ms.start !== a.requested_ms.start && (
                <span className="text-muted" title="Nearest decodable frame to the requested time">
                  asked {mmss(a.requested_ms.start)}
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** The whole result block: answer, matches, coverage, no-match state. */
export function SearchResultBlock({
  result,
  activeId,
  onSelect,
}: {
  result: SearchResult;
  activeId?: string;
  onSelect?: (m: Match) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-xs uppercase tracking-wide text-muted">Query</p>
        <p className="font-display text-base font-semibold">{result.query}</p>
      </div>
      {result.matches.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line px-4 py-5" role="status">
          <p className="font-display text-sm font-semibold">No match in this video</p>
          <p className="mt-1 text-sm text-muted">{result.answer || "Nothing in the indexed frames or transcript answers this query."}</p>
        </div>
      ) : (
        <>
          <p className="text-sm leading-relaxed">{result.answer}</p>
          <ol className="flex flex-col gap-2" aria-label="Matches">
            {result.matches.map((m, i) => (
              <li key={m.match_id}>
                <MatchCard m={m} index={i} active={activeId === m.match_id} onSelect={onSelect} />
              </li>
            ))}
          </ol>
        </>
      )}
      <CoverageNote coverage={result.coverage} />
    </div>
  );
}
