"use client";

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Check, Copy, Play } from "lucide-react";
import type { JobView } from "@/lib/reduce";
import type { Scenario } from "@/lib/scenario";
import { ts } from "@/lib/format";
import { Frame } from "./Frames";
import { Player } from "./Player";

export function Report({
  sc,
  view,
  t,
  setT,
}: {
  sc: Scenario;
  view: JobView;
  t: number;
  setT: Dispatch<SetStateAction<number>>;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const report = view.report;
  if (!report) return null;

  const observedLabel = report.kind === "answer" ? "Answer basis" : "Observed behavior";

  const markdown = [
    `# ${report.title}`,
    "",
    report.subtitle,
    "",
    "## Findings",
    ...report.findings.map((f, i) => `${i + 1}. [${ts(f.t_ms)}] ${f.text}`),
    "",
    `## ${observedLabel}`,
    report.observed,
    "",
    `_${report.caveat}_`,
    "",
  ].join("\n");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <article className="animate-rise space-y-10">
      <header>
        <p className="font-mono text-[11px] uppercase tracking-wider text-muted">
          JOB {view.jobId} · REPORT READY
        </p>
        <h2 className="mt-4 font-display text-4xl leading-[1.05] tracking-tighter sm:text-6xl">
          {report.title}
        </h2>
        <p className="mt-4 max-w-2xl text-lg text-muted">{report.subtitle}</p>
        <p className="mt-3 break-all font-mono text-xs text-muted">
          {view.sourceName} · {ts(view.durationMs)}
        </p>
      </header>

      <section aria-labelledby="findings-h">
        <h3 id="findings-h" className="font-mono text-[11px] uppercase tracking-wider text-muted">
          Findings
        </h3>
        <ol className="mt-4 space-y-4">
          {report.findings.map((f, i) => (
            <li key={i} className="flex items-start gap-4">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-rail font-mono text-xs text-lime">
                {i + 1}
              </span>
              <div className="min-w-0 pt-0.5">
                <button
                  type="button"
                  onClick={() => setT(f.t_ms)}
                  className="mr-2 rounded-md border border-line px-1.5 py-0.5 font-mono text-xs transition hover:bg-lime hover:text-lime-ink focus-visible:outline-2 focus-visible:outline-stripe"
                >
                  {ts(f.t_ms)}
                </button>
                <span className="text-base">{f.text}</span>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="rounded-2xl border border-line bg-card p-6 sm:p-8">
        <h3 className="font-mono text-[11px] uppercase tracking-wider text-muted">
          {observedLabel}
        </h3>
        <p className="mt-3 text-lg leading-relaxed">{report.observed}</p>
        <p className="mt-3 text-sm text-muted">{report.caveat}</p>
      </section>

      {report.evidence.length > 0 && (
        <section aria-labelledby="evidence-h">
          <h3 id="evidence-h" className="font-mono text-[11px] uppercase tracking-wider text-muted">
            Evidence
          </h3>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {report.evidence.map((e, i) => (
              <figure key={i} className="rounded-2xl border border-line bg-card p-3">
                <div className="aspect-[16/10] overflow-hidden rounded-xl border-2 border-line">
                  <Frame state={sc.frameAt(e.t_ms)} className="h-full w-full" />
                </div>
                <figcaption className="mt-3 flex items-center gap-2 px-1 text-sm">
                  <button
                    type="button"
                    onClick={() => setT(e.t_ms)}
                    className="rounded-md border border-line px-1.5 py-0.5 font-mono text-xs transition hover:bg-lime hover:text-lime-ink focus-visible:outline-2 focus-visible:outline-stripe"
                  >
                    {ts(e.t_ms)}
                  </button>
                  <span>{e.label}</span>
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      )}

      <section aria-label="Source clip" className="rounded-2xl border border-line bg-card p-3">
        <Player sc={sc} view={view} t={t} setT={setT} compact />
      </section>

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => setT(view.retrieval?.start_ms ?? report.findings[0]?.t_ms ?? 0)}
          className="inline-flex items-center gap-2 rounded-xl bg-lime px-5 py-3 text-sm font-semibold text-lime-ink transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stripe"
        >
          <Play className="size-4 fill-current" aria-hidden />
          Open source clip
        </button>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-2 rounded-xl border border-line px-5 py-3 text-sm font-semibold transition hover:bg-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stripe"
        >
          {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
          <span aria-live="polite">{copied ? "Copied" : "Copy report"}</span>
        </button>
      </div>
    </article>
  );
}
