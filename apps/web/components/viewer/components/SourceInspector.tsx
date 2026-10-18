import { useEffect, useMemo, useRef, useState } from "react";
import { Api, ApiError, type JobView } from "../api/client";
import { toApiError } from "../api/hooks";
import type { SearchResult } from "../api/types";
import { mmss, parseTime, range, requestIdFor, seconds, settleRequest } from "../lib/format";
import { CLIP_MAX_MS, FRAMES_MAX } from "../lib/limits";
import { ErrorPanel } from "./Shell";
import { Badge, Button, Card, SectionTitle } from "./ui";

type Match = SearchResult["matches"][number];

export function SourceInspector({
  job,
  matches,
  activeMatchId,
  onSelectMatch,
  onChanged,
}: {
  job: JobView;
  matches: Match[];
  activeMatchId?: string;
  onSelectMatch: (m: Match) => void;
  onChanged: () => void;
}) {
  const v = job.video;
  const dur = v.duration_ms ?? 0;
  const video = useRef<HTMLVideoElement>(null);
  const [src, setSrc] = useState<{ url: string } | { error: string } | null>(null);
  const [t, setT] = useState(0);
  const [frames, setFrames] = useState<number[]>([]);
  const [clipStart, setClipStart] = useState("");
  const [clipEnd, setClipEnd] = useState("");
  const [busy, setBusy] = useState<"frames" | "clip" | null>(null);
  const [err, setErr] = useState<ApiError>();
  const [note, setNote] = useState<string>();

  // Original upload, authorized per view. Source id = video id (see assumptions in the report).
  const fetchSrc = () =>
    Api.access(v.video_id)
      .then((r) => setSrc({ url: r.url }))
      .catch((e) => setSrc({ error: toApiError(e).message }));
  useEffect(() => {
    void fetchSrc();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.video_id]);

  // Seek when a match is selected from the results list.
  const active = matches.find((m) => m.match_id === activeMatchId);
  const activeStart = active?.start_ms;
  useEffect(() => {
    if (activeStart !== undefined && video.current) {
      video.current.currentTime = activeStart / 1000;
      setT(activeStart);
    }
  }, [activeMatchId, activeStart]);

  const seek = (ms: number) => {
    if (video.current) video.current.currentTime = ms / 1000;
    setT(ms);
  };

  const framesLeft = Math.max(0, job.remaining.frames);
  const frameCap = Math.min(FRAMES_MAX, framesLeft);
  const paid = job.payment_state === "paid" && job.state === "ready";
  const clipLeft = Math.min(CLIP_MAX_MS, Math.max(0, job.remaining.clip_ms));

  const cs = parseTime(clipStart);
  const ce = parseTime(clipEnd);
  const clipProblem = useMemo(() => {
    if (!clipStart && !clipEnd) return "Set a start and end.";
    if (cs == null || ce == null) return "Enter times as m:ss.";
    if (ce <= cs) return "End must be after start.";
    if (dur && ce > dur) return `End is past the video (${mmss(dur)}).`;
    if (ce - cs > CLIP_MAX_MS) return `Clips are at most ${seconds(CLIP_MAX_MS)}.`;
    if (ce - cs > clipLeft) return clipLeft === 0 ? "No clip allowance left in this pack." : `Only ${seconds(clipLeft)} of clip allowance left.`;
    return null;
  }, [cs, ce, clipStart, clipEnd, dur, clipLeft]);
  const frameProblem =
    frames.length === 0 ? "Add at least one timestamp." : frames.length > frameCap ? `Only ${frameCap} frames left.` : null;

  async function submitFrames() {
    setBusy("frames");
    setErr(undefined);
    const body = { timestamps_ms: [...frames].sort((a, b) => a - b) };
    const key = `frames:${job.job_id}:${body.timestamps_ms.join(",")}`;
    try {
      await Api.frames(job.job_id, { request_id: requestIdFor(key), ...body });
      settleRequest(key);
      setFrames([]);
      setNote("Frame extraction requested. Results appear below when the worker finishes.");
      onChanged();
    } catch (e) {
      setErr(toApiError(e));
    } finally {
      setBusy(null);
    }
  }
  async function submitClip() {
    if (cs == null || ce == null) return;
    setBusy("clip");
    setErr(undefined);
    const key = `clip:${job.job_id}:${cs}-${ce}`;
    try {
      await Api.clip(job.job_id, { request_id: requestIdFor(key), start_ms: cs, end_ms: ce });
      settleRequest(key);
      setNote("Clip extraction requested. It is only playable once the worker has produced the file.");
      onChanged();
    } catch (e) {
      setErr(toApiError(e));
    } finally {
      setBusy(null);
    }
  }

  const pct = (ms: number) => (dur > 0 ? Math.min(100, Math.max(0, (ms / dur) * 100)) : 0);

  return (
    <Card aria-labelledby="src-h">
      <SectionTitle id="src-h" aside={<Badge tone="neutral" title="This is the file you uploaded, authorized for you only.">Original upload</Badge>}>
        Source
      </SectionTitle>

      <div className="overflow-hidden rounded-xl bg-code">
        {src && "url" in src ? (
          <video
            ref={video}
            src={src.url}
            controls
            preload="metadata"
            className="aspect-video w-full"
            onTimeUpdate={(e) => setT(Math.round(e.currentTarget.currentTime * 1000))}
            onError={() => void fetchSrc()}
            aria-label="Original uploaded video"
          />
        ) : (
          <div className="grid aspect-video place-items-center px-4 text-center text-sm text-rail-text/70">
            {src ? `Original preview unavailable: ${src.error}` : "Authorizing preview…"}
          </div>
        )}
      </div>

      {/* Timeline with match markers; the range input is the keyboard-accessible scrubber */}
      <div className="mt-3">
        <div className="relative h-8">
          <div className="absolute inset-x-0 top-3 h-2 rounded-full bg-line" aria-hidden="true" />
          {matches.map((m, i) => (
            <button
              key={m.match_id}
              type="button"
              onClick={() => onSelectMatch(m)}
              aria-label={`Match ${i + 1}, ${range(m.start_ms, m.end_ms)}`}
              title={`Match ${i + 1} · ${range(m.start_ms, m.end_ms)}`}
              className={`absolute top-1.5 h-5 min-w-2.5 rounded-sm border ${m.match_id === activeMatchId ? "border-stripe bg-stripe" : "border-lime-ink/30 bg-lime"}`}
              style={{ left: `${pct(m.start_ms)}%`, width: `max(10px, ${pct(m.end_ms) - pct(m.start_ms)}%)` }}
            />
          ))}
          <div className="pointer-events-none absolute top-1 h-6 w-0.5 bg-text" style={{ left: `${pct(t)}%` }} aria-hidden="true" />
        </div>
        <input
          type="range"
          min={0}
          max={Math.max(dur, 1)}
          step={100}
          value={Math.min(t, Math.max(dur, 1))}
          onChange={(e) => seek(Number(e.target.value))}
          aria-label="Seek in original video"
          aria-valuetext={`${mmss(t)} of ${mmss(dur)}`}
          className="w-full accent-[var(--stripe)]"
        />
        <div className="flex justify-between font-mono text-xs text-muted">
          <span>{mmss(t)}</span>
          <span>{mmss(dur)}</span>
        </div>
      </div>

      {!paid ? (
        <p className="mt-4 text-sm text-muted">
          {job.payment_state === "reconciling" ? "Frame and clip export unlock once the payment is verified." : job.state === "failed" ? "Export is unavailable because this job failed." : job.state === "expired" ? "This pack expired; exports are closed." : "Frame and clip export unlock after payment and indexing."}
        </p>
      ) : (
        <div className="mt-4 grid gap-5 md:grid-cols-2">
          <fieldset className="min-w-0">
            <legend className="text-sm font-medium">Request frames</legend>
            <p className="text-xs text-muted">{framesLeft} of {job.quote.limits.frames} frames left in this pack.</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {frames.map((f) => (
                <button key={f} type="button" onClick={() => setFrames(frames.filter((x) => x !== f))} aria-label={`Remove frame at ${mmss(f)}`} className="rounded-full bg-line px-2.5 py-1 font-mono text-xs hover:bg-danger-soft">
                  {mmss(f)} ×
                </button>
              ))}
              {frames.length === 0 && <span className="text-xs text-muted">None selected</span>}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button disabled={frames.includes(t) || frames.length >= frameCap || (dur > 0 && t > dur)} onClick={() => setFrames([...frames, t])}>
                Add {mmss(t)}
              </Button>
              <Button variant="primary" busy={busy === "frames"} disabled={!!frameProblem} onClick={submitFrames}>
                Get {frames.length || ""} frame{frames.length === 1 ? "" : "s"}
              </Button>
            </div>
            {frameProblem && frames.length > 0 && <p className="mt-1 text-xs text-danger">{frameProblem}</p>}
          </fieldset>

          <fieldset className="min-w-0">
            <legend className="text-sm font-medium">Export a clip</legend>
            <p className="text-xs text-muted">{seconds(Math.max(0, job.remaining.clip_ms))} of clip allowance left · max {seconds(CLIP_MAX_MS)} each.</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="text-xs">
                Start
                <input value={clipStart} onChange={(e) => setClipStart(e.target.value)} inputMode="decimal" placeholder="0:00" className="mt-0.5 block min-h-10 w-full rounded-lg border border-line bg-paper px-2 font-mono text-sm" />
              </label>
              <label className="text-xs">
                End
                <input value={clipEnd} onChange={(e) => setClipEnd(e.target.value)} inputMode="decimal" placeholder="0:10" className="mt-0.5 block min-h-10 w-full rounded-lg border border-line bg-paper px-2 font-mono text-sm" />
              </label>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button onClick={() => setClipStart(mmss(t))}>Start = {mmss(t)}</Button>
              <Button onClick={() => setClipEnd(mmss(t))}>End = {mmss(t)}</Button>
              {active && <Button variant="ghost" onClick={() => { setClipStart(mmss(active.start_ms)); setClipEnd(mmss(Math.min(active.end_ms, active.start_ms + clipLeft))); }}>Use match</Button>}
            </div>
            <Button className="mt-2" variant="primary" busy={busy === "clip"} disabled={!!clipProblem} onClick={submitClip}>
              Export clip
            </Button>
            {clipProblem && (clipStart || clipEnd) && <p className="mt-1 text-xs text-danger">{clipProblem}</p>}
          </fieldset>
        </div>
      )}

      {note && !err && <p role="status" className="mt-3 text-sm text-muted">{note}</p>}
      {err && <div className="mt-3"><ErrorPanel error={err} /></div>}
    </Card>
  );
}
