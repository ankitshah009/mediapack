/** The single MCP App binding is get_job; it projects persisted API results. */
import { ThemeProvider, useToolContext, useViewTheme } from "mcp-use/react";
import "./view.css";

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue => v !== null && typeof v === "object" && !Array.isArray(v) ? v as ObjectValue : {};
const items = (v: unknown): ObjectValue[] => Array.isArray(v) ? v.map(object) : [];
const text = (v: unknown, fallback = ""): string => typeof v === "string" ? v : fallback;
const time = (v: unknown) => {
  const seconds = typeof v === "number" ? Math.max(0, Math.floor(v / 1000)) : 0;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
const safeUrl = (v: unknown): string | undefined => {
  if (typeof v !== "string") return;
  try { const url = new URL(v); return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined; } catch { return; }
};

function Results() {
  const ctx = useToolContext();
  const theme = useViewTheme();
  if (ctx.status === "pending") return <div className="mp-view" data-theme={theme} role="status" aria-busy="true">Loading MediaPack job…</div>;
  if (ctx.status === "error") return <div className="mp-view" data-theme={theme} role="alert">{ctx.error.message || "The tool returned an error."}</div>;
  const job = object(ctx.toolOutput);
  const video = object(job.video);
  const quote = object(job.quote);
  const operations = items(job.operations);
  const search = [...operations].reverse().find((op) => op.kind === "search_video" && op.state === "succeeded");
  const result = object(search?.result);
  const remaining = object(job.remaining);
  const artifacts = operations.filter((op) => op.state === "succeeded").flatMap((op) => items(object(op.result).artifacts));
  const unique = artifacts.filter((artifact, index) => artifacts.findIndex((a) => a.artifact_id === artifact.artifact_id) === index);
  return <section className="mp-view" data-theme={theme} aria-label="MediaPack results">
    <div className="mp-badges"><span>Stripe {text(quote.payment_mode, "test")} mode</span><span>{text(job.payment_state, "unknown")}</span><span>{text(job.state, "unknown")}</span></div>
    <h1>{text(video.file_name, "MediaPack job")}</h1>
    <p role="status">{text(job.next_action)}</p>
    {search && <section aria-label="Latest search"><h2>{text(result.query)}</h2><p>{text(result.answer)}</p>
      {items(result.matches).length === 0 ? <p>No matching evidence was found.</p> : <ol className="mp-matches">{items(result.matches).map((match, i) => <li key={text(match.match_id, String(i))}><strong>{time(match.start_ms)}–{time(match.end_ms)}</strong><p>{text(match.description)}</p>{typeof match.transcript_excerpt === "string" && <blockquote>{match.transcript_excerpt}</blockquote>}<small>{text(match.evidence_status)} · {Array.isArray(match.modalities) ? match.modalities.filter((m) => typeof m === "string").join(", ") : ""}</small></li>)}</ol>}
      <ul>{(Array.isArray(object(result.coverage).limitations) ? object(result.coverage).limitations as unknown[] : []).map((limit, i) => typeof limit === "string" ? <li key={i}>{limit}</li> : null)}</ul>
    </section>}
    {unique.length > 0 && <section aria-label="Delivered evidence"><h2>Source evidence</h2><div className="mp-artifacts">{unique.map((artifact) => {
      const url = safeUrl(artifact.url);
      return <figure key={text(artifact.artifact_id)}>
        {url ? artifact.kind === "clip" ? <video controls preload="metadata" src={url} /> : <a href={url} target="_blank" rel="noreferrer"><img loading="lazy" src={url} alt={`Source frame at ${time(object(artifact.actual_ms).start)}`} /></a> : <p>Evidence URL unavailable; call get_pack to refresh access.</p>}
        <figcaption>{artifact.kind === "clip" ? "Clip" : "Frame"} at {time(object(artifact.actual_ms).start)} · source evidence</figcaption>
      </figure>;
    })}</div></section>}
    {operations.filter((op) => op.state !== "succeeded").map((op) => <p key={text(op.operation_id)} role={op.state === "failed" ? "alert" : "status"}>{text(op.kind).replaceAll("_", " ")}: {text(op.state)}{object(op.error).message ? ` — ${text(object(op.error).message)}` : ""}</p>)}
    {Object.keys(remaining).length > 0 && <section aria-label="Remaining allowance"><h2>Remaining allowance</h2><div className="mp-badges">{Object.entries(remaining).map(([key, value]) => <span key={key}>{typeof value === "number" ? value.toLocaleString() : "—"} {key.replaceAll("_", " ")}</span>)}</div></section>}
    <small>Observed video content supports these results. Video alone cannot establish root cause.</small>
  </section>;
}

export default function SearchResultsView() {
  return <ThemeProvider><Results /></ThemeProvider>;
}
