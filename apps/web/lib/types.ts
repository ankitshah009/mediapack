// Shared contract. Mirrors PLAN.md §5 — the real app persists these rows in Supabase `events`.

export type Source = "api" | "stripe" | "primitive" | "worker" | "agent";

export interface Allowance {
  text_tokens: number;
  frames: number;
  clip_ms: number;
  max_duration_ms: number;
}

export interface Hit {
  start_ms: number;
  end_ms: number;
  score: number; // 0..1
  caption: string;
}

export interface Report {
  kind: "bug" | "answer";
  title: string;
  subtitle: string;
  findings: { t_ms: number; text: string }[];
  observed: string;
  caveat: string;
  evidence: { t_ms: number; label: string }[]; // e.g. before/after frames
}

type E<T extends string, S extends Source, D> = {
  id: number;
  job_id: string;
  type: T;
  source: S;
  data: D;
  created_at: string; // ISO
};

export type JobEvent =
  | E<"job.created", "api", { source_name: string; duration_ms: number; task: string; requested_by: string }>
  | E<"quote.issued", "api", { amount_cents: number; allowance: Allowance; expires_at: string }>
  | E<"payment.challenge", "stripe", { challenge_id: string }>
  | E<"payment.verified", "stripe", { payment_id: string; amount_cents: number; mode: "test" | "live" }>
  | E<"primitive.dispatched", "primitive", { message_id: string; to: string }>
  | E<"worker.started", "worker", { sandbox_id: string }>
  | E<"worker.progress", "worker", { stage: "probe" | "detect" | "transcribe" | "caption"; pct: number }>
  | E<"worker.indexed", "worker", { segments: number; keyframes: number; ms_elapsed: number; cost_cents: number }>
  | E<"agent.search", "agent", { query: string; hits: Hit[]; text_tokens: number }>
  | E<"agent.retrieved", "agent", { start_ms: number; end_ms: number; frames_ms: number[]; clip_ms: number }>
  | E<"primitive.delivered", "primitive", { message_id: string; artifacts: number }>
  | E<"report.ready", "agent", { report: Report }>;

export type EventType = JobEvent["type"];

/** An event before persistence (no id/job_id/created_at). Distributive over the union. */
export type DraftEvent = JobEvent extends infer T
  ? T extends JobEvent
    ? Omit<T, "id" | "job_id" | "created_at">
    : never
  : never;

// ---- Simulated pixels (prototype only; production renders <img> keyframes from Storage) ----

export type FrameState =
  | {
      kind: "ui";
      page: "general" | "connection";
      value: string;
      typing: boolean;
      saved: boolean;
      loading: boolean;
    }
  | {
      kind: "talk";
      title: string;
      bullets: string[];
      speaker: string;
      caption: string;
    };
