import type { DraftEvent, FrameState } from "./types";
import type { Phase } from "./reduce";

export interface Scripted {
  /** ms after the previous scripted event */
  delay: number;
  event: DraftEvent;
}

/** A replayable demo run. Prototype only — production reads real events from Supabase Realtime. */
export interface Scenario {
  id: "bug" | "talk";
  label: string; // switcher label
  jobId: string;
  kind: "ui" | "talk";
  thumbs: number; // filmstrip thumbnail count
  copy: Record<Phase, { title: string; sub: string }>;
  frameAt: (t_ms: number) => FrameState;
  prePay: Scripted[]; // job.created → quote.issued → payment.challenge
  postPay: Scripted[]; // payment.verified → … → report.ready
}
