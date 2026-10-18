import type { JobEvent, OperationView } from "../api/client";

const TITLES: Record<string, string> = {
  "quote.issued": "Quote issued",
  "payment.challenge": "Payment required (402)",
  "payment.verified": "Payment verified",
  "payment.reconciling": "Payment outcome pending",
  "primitive.request_sent": "Work request sent",
  "primitive.request_delivered": "Work request delivered",
  "primitive.result_received": "Result received",
  "worker.launched": "Worker launched",
  "worker.started": "Worker started",
  "operation.queued": "Operation queued",
  "operation.succeeded": "Operation succeeded",
  "operation.failed": "Operation failed",
  "operation.retried": "Operation retried",
};
export const title = (k: string) => TITLES[k] ?? k.replace(/[._]/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** Short stage labels for the compact per-step track. */
const STAGE: Record<string, string> = {
  "video.created": "Uploaded",
  "video.probe_queued": "Queued",
  "quote.issued": "Quote",
  "payment.challenge": "402",
  "payment.verified": "Paid",
  "payment.reconciling": "Reconciling",
  "primitive.request_sent": "Primitive",
  "primitive.request_delivered": "Delivered",
  "primitive.result_received": "Result",
  "worker.launched": "Blaxel worker",
  "worker.claimed": "Claimed",
  "worker.started": "Started",
  "operation.queued": "Queued",
  "operation.succeeded": "Done",
  "operation.failed": "Failed",
  "operation.retried": "Retry",
  "operation.retrying": "Retry",
};
export const stage = (k: string) => STAGE[k] ?? title(k);

const KIND_LABEL: Record<string, string> = {
  probe_video: "Verify media",
  index_video: "Index video",
  search_video: "Search",
  extract_frames: "Frames",
  extract_clip: "Clip",
};

export type Step = { key: string; label: string; detail?: string; events: JobEvent[]; status: "done" | "failed" | "active" };

const short = (s: string, n = 64) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function describe(op: OperationView | undefined): string | undefined {
  if (!op) return undefined;
  const i = op.input as Record<string, unknown>;
  if (op.kind === "search_video" && typeof i.query === "string") return `“${short(i.query)}”`;
  if (op.kind === "extract_frames" && Array.isArray(i.timestamps_ms)) return `${i.timestamps_ms.length} frame${i.timestamps_ms.length === 1 ? "" : "s"}`;
  if (op.kind === "extract_clip" && typeof i.start_ms === "number" && typeof i.end_ms === "number") {
    return `${((i.end_ms - i.start_ms) / 1000).toFixed(0)}s of source`;
  }
  return undefined;
}

/** Fold the raw event log into one step per operation (payment events form their own step). */
export function groupSteps(events: JobEvent[], operations: OperationView[] = []): Step[] {
  const ops = new Map(operations.map((o) => [o.operation_id, o]));
  const steps: Step[] = [];
  const byKey = new Map<string, Step>();
  const seen = new Set<number>();
  for (const e of events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const key = e.operation_id ?? (/^(quote|payment)\./.test(e.kind) ? "payment" : `video:${e.kind.split(".")[0]}`);
    let s = byKey.get(key);
    if (!s) {
      const op = e.operation_id ? ops.get(e.operation_id) : undefined;
      const kind = op?.kind ?? (typeof e.details.kind === "string" ? e.details.kind : undefined);
      const label = key === "payment" ? "Purchase" : kind ? KIND_LABEL[kind] ?? kind
        : e.kind === "video.created" ? "Upload" : e.kind.startsWith("video.probe") ? KIND_LABEL.probe_video : title(e.kind);
      s = { key, label, detail: describe(op), events: [], status: "active" };
      byKey.set(key, s);
      steps.push(s);
    }
    s.events.push(e);
  }
  for (const s of steps) {
    const op = ops.get(s.key);
    const last = s.events[s.events.length - 1].kind;
    if (op) s.status = op.state === "succeeded" ? "done" : op.state === "failed" ? "failed" : "active";
    else if (s.key === "payment") s.status = s.events.some((e) => e.kind === "payment.verified") ? "done" : "active";
    else s.status = /failed/.test(last) ? "failed" : /succeeded|created|issued/.test(last) ? "done" : "active";
  }
  return steps;
}

