import { test } from "node:test";
import assert from "node:assert/strict";
import { project } from "./reduce.ts";
import type { JobEvent } from "./types.ts";

let n = 0;
const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
const ev = (type: string, source: string, data: unknown, s = ++n) =>
  ({ id: ++n, job_id: "J", type, source, data, created_at: at(s) }) as unknown as JobEvent;

const allowance = { text_tokens: 2000, frames: 8, clip_ms: 15000, max_duration_ms: 180000 };
const base = [
  ev("job.created", "api", { source_name: "a.mp4", duration_ms: 1000, task: "t", requested_by: "x" }, 1),
  ev("quote.issued", "api", { amount_cents: 50, allowance, expires_at: at(99) }, 2),
];

test("phase progression", () => {
  assert.equal(project("J", base).phase, "quoted");
  assert.equal(project("J", base, true).phase, "paying");
  const paid = [...base, ev("payment.verified", "stripe", { payment_id: "pi", amount_cents: 50, mode: "test" }, 3)];
  assert.equal(project("J", paid, true).phase, "processing");
  const started = [...paid, ev("worker.started", "worker", { sandbox_id: "s" }, 4)];
  assert.equal(project("J", started).phase, "indexing");
  const indexed = [...started, ev("worker.indexed", "worker", { segments: 1, keyframes: 1, ms_elapsed: 1, cost_cents: 1 }, 5)];
  assert.equal(project("J", indexed).phase, "inspecting");
  const done = [...indexed, ev("report.ready", "agent", { report: { kind: "bug" } }, 6)];
  assert.equal(project("J", done).phase, "delivered");
});

test("usage accumulates", () => {
  const evs = [
    ...base,
    ev("agent.search", "agent", { query: "a", hits: [], text_tokens: 640 }, 3),
    ev("agent.search", "agent", { query: "b", hits: [], text_tokens: 644 }, 4),
    ev("agent.retrieved", "agent", { start_ms: 0, end_ms: 10, frames_ms: [1, 2, 3], clip_ms: 12000 }, 5),
  ];
  const v = project("J", evs);
  assert.deepEqual(v.usage, { text_tokens: 1284, frames: 3, clip_ms: 12000 });
  assert.equal(v.searches.length, 2);
});

test("step timestamps are set from events and stable across re-projection", () => {
  const evs = [...base, ev("payment.verified", "stripe", { payment_id: "pi", amount_cents: 50, mode: "test" }, 3)];
  const a = project("J", evs);
  const b = project("J", evs);
  assert.equal(a.steps.quote, at(2));
  assert.equal(a.steps.paid, at(3));
  assert.deepEqual(a.steps, b.steps);
});
