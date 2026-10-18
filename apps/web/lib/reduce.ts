import type { Allowance, Hit, JobEvent, Report } from "./types";

export const STEPS = ["quote", "paid", "dispatched", "indexed", "retrieved", "delivered"] as const;
export type Step = (typeof STEPS)[number];

export type Phase = "quoted" | "paying" | "processing" | "indexing" | "inspecting" | "delivered";

export interface JobView {
  jobId: string;
  sourceName?: string;
  durationMs: number;
  task?: string;
  requestedBy?: string;
  quote?: { amount_cents: number; allowance: Allowance; expires_at: string };
  challengeId?: string;
  payment?: { payment_id: string; amount_cents: number; mode: "test" | "live" };
  dispatch?: { message_id: string; to: string };
  sandboxId?: string;
  progress?: { stage: string; pct: number };
  index?: { segments: number; keyframes: number; ms_elapsed: number; cost_cents: number };
  searches: { query: string; hits: Hit[]; text_tokens: number; at: string }[];
  retrieval?: { start_ms: number; end_ms: number; frames_ms: number[]; clip_ms: number };
  delivery?: { message_id: string; artifacts: number };
  report?: Report;
  usage: { text_tokens: number; frames: number; clip_ms: number };
  /** ISO timestamp at which each pipeline step completed. */
  steps: Partial<Record<Step, string>>;
  phase: Phase;
  events: JobEvent[];
}

export function emptyView(jobId: string): JobView {
  return {
    jobId,
    durationMs: 0,
    searches: [],
    usage: { text_tokens: 0, frames: 0, clip_ms: 0 },
    steps: {},
    phase: "quoted",
    events: [],
  };
}

function apply(v: JobView, e: JobEvent): JobView {
  const next: JobView = { ...v, events: [...v.events, e] };
  switch (e.type) {
    case "job.created":
      return { ...next, sourceName: e.data.source_name, durationMs: e.data.duration_ms, task: e.data.task, requestedBy: e.data.requested_by };
    case "quote.issued":
      return { ...next, quote: e.data, steps: { ...v.steps, quote: e.created_at } };
    case "payment.challenge":
      return { ...next, challengeId: e.data.challenge_id };
    case "payment.verified":
      return { ...next, payment: e.data, steps: { ...v.steps, paid: e.created_at } };
    case "primitive.dispatched":
      return { ...next, dispatch: e.data, steps: { ...v.steps, dispatched: e.created_at } };
    case "worker.started":
      return { ...next, sandboxId: e.data.sandbox_id, progress: { stage: "probe", pct: 0 } };
    case "worker.progress":
      return { ...next, progress: e.data };
    case "worker.indexed":
      return { ...next, index: e.data, progress: undefined, steps: { ...v.steps, indexed: e.created_at } };
    case "agent.search":
      return {
        ...next,
        searches: [...v.searches, { ...e.data, at: e.created_at }],
        usage: { ...v.usage, text_tokens: v.usage.text_tokens + e.data.text_tokens },
      };
    case "agent.retrieved":
      return {
        ...next,
        retrieval: e.data,
        usage: { ...v.usage, frames: v.usage.frames + e.data.frames_ms.length, clip_ms: v.usage.clip_ms + e.data.clip_ms },
        steps: { ...v.steps, retrieved: e.created_at },
      };
    case "primitive.delivered":
      return { ...next, delivery: e.data, steps: { ...v.steps, delivered: e.created_at } };
    case "report.ready":
      return { ...next, report: e.data.report };
  }
}

function phaseOf(v: JobView, approving: boolean): Phase {
  if (v.report) return "delivered";
  if (v.index) return "inspecting";
  if (v.sandboxId || v.progress) return "indexing";
  if (v.payment) return "processing";
  if (approving) return "paying";
  return "quoted";
}

/** Pure projection: events → view. `approving` is UI-local (user opened Link approval). */
export function project(jobId: string, events: JobEvent[], approving = false): JobView {
  const v = events.reduce(apply, emptyView(jobId));
  return { ...v, phase: phaseOf(v, approving) };
}
