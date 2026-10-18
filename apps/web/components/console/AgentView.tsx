"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import type { JobView, Phase } from "@/lib/reduce";

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

const NEXT: Record<Phase, (id: string) => string> = {
  quoted: (id) => `POST /api/v1/jobs/${id}/purchase (402 MPP) — pay with \`link\``,
  paying: () => "Awaiting Link approval; retry the purchase with the payment credential",
  processing: () => "Payment verified. Work request dispatched via Primitive; poll get_job until status is inspecting",
  indexing: () => "Worker is indexing. Poll get_job until index is present",
  inspecting: (id) => `POST /api/v1/jobs/${id}/search { "query": "..." } then GET /api/v1/jobs/${id}/frames/{t}.jpg`,
  delivered: () => "Done. Read report and evidence; no further action required",
};

function build(view: JobView): Json {
  const id = view.jobId;
  const a = view.quote?.allowance;
  const u = view.usage;
  const r = view.retrieval;
  return {
    job_id: id,
    status: view.phase,
    source: { name: view.sourceName ?? null, duration_ms: view.durationMs },
    quote: view.quote
      ? { amount_usd: view.quote.amount_cents / 100, allowance: { ...view.quote.allowance }, expires_at: view.quote.expires_at }
      : null,
    payment: view.payment
      ? { payment_id: view.payment.payment_id, amount_usd: view.payment.amount_cents / 100, mode: view.payment.mode }
      : null,
    index: view.index
      ? { segments: view.index.segments, keyframes: view.index.keyframes, elapsed_ms: view.index.ms_elapsed }
      : view.progress
        ? { in_progress: true, stage: view.progress.stage, pct: view.progress.pct }
        : null,
    usage: { ...u },
    usage_remaining: a
      ? {
          text_tokens: Math.max(0, a.text_tokens - u.text_tokens),
          frames: Math.max(0, a.frames - u.frames),
          clip_ms: Math.max(0, a.clip_ms - u.clip_ms),
        }
      : null,
    searches: view.searches.map((s) => ({
      query: s.query,
      top_hits: s.hits.slice(0, 2).map((h) => ({ start_ms: h.start_ms, end_ms: h.end_ms, score: h.score, caption: h.caption })),
    })),
    evidence: r
      ? {
          window_ms: [r.start_ms, r.end_ms],
          frames: r.frames_ms.map((t) => `/api/v1/jobs/${id}/frames/${t}.jpg`),
          clip: `/api/v1/jobs/${id}/clip.mp4`,
        }
      : null,
    next_action: NEXT[view.phase](id),
  };
}

function highlight(value: Json, indent = 0): ReactNode[] {
  const pad = "  ".repeat(indent);
  const pad1 = "  ".repeat(indent + 1);
  if (value === null) return [<span key="n" className="text-white/40">null</span>];
  if (typeof value === "string") return [<span key="s" className="text-[#e8e6da]">{JSON.stringify(value)}</span>];
  if (typeof value === "number") return [<span key="d" className="text-lime">{value}</span>];
  if (typeof value === "boolean") return [<span key="b" className="text-worker">{String(value)}</span>];
  if (Array.isArray(value)) {
    if (value.length === 0) return ["[]"];
    if (value.every((v) => typeof v === "number")) {
      return [
        "[",
        ...value.flatMap((v, i) => [<span key={i} className="text-lime">{String(v)}</span>, i < value.length - 1 ? ", " : ""]),
        "]",
      ];
    }
    return [
      "[\n",
      ...value.flatMap((v, i) => [pad1, ...highlight(v, indent + 1), i < value.length - 1 ? ",\n" : "\n"]),
      pad + "]",
    ];
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return ["{}"];
  return [
    "{\n",
    ...entries.flatMap(([k, v], i) => [
      pad1,
      <span key={`k${i}`} className="text-[#b9cf6a]">{JSON.stringify(k)}</span>,
      ": ",
      ...highlight(v, indent + 1),
      i < entries.length - 1 ? ",\n" : "\n",
    ]),
    pad + "}",
  ];
}

export function AgentView({ view }: { view: JobView }) {
  const [copied, setCopied] = useState(false);
  const json = useMemo(() => build(view), [view]);
  const text = useMemo(() => JSON.stringify(json, null, 2), [json]);
  const nodes = useMemo(() => highlight(json), [json]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section aria-labelledby="agent-h" className="min-w-0">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="agent-h" className="font-display text-lg font-semibold tracking-tight">
          What your agent sees
        </h2>
        <code className="break-all font-mono text-xs text-muted">get_job(&quot;{view.jobId}&quot;)</code>
      </div>
      <div className="relative rounded-2xl bg-code ring-1 ring-white/10">
        <button
          type="button"
          onClick={copy}
          aria-label="Copy JSON"
          className="absolute right-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-md bg-white/10 px-2 py-1 text-xs text-rail-text transition-colors hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-lime"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-lime" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
          <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
        </button>
        <pre
          tabIndex={0}
          aria-label={`get_job response for ${view.jobId}`}
          className="max-h-[70vh] overflow-auto rounded-2xl p-4 pr-24 font-mono text-[12px] leading-relaxed text-rail-text focus-visible:outline-2 focus-visible:outline-lime"
        >
          <code>{nodes}</code>
        </pre>
      </div>
    </section>
  );
}
