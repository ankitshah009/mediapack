import assert from "node:assert/strict";
import { test } from "node:test";
import { groupSteps } from "./steps.ts";

const OP = "00000000-0000-4000-8000-0000000000a1";
const ev = (id: number, kind: string, operation_id: string | null = null, details: Record<string, unknown> = {}) =>
  ({ id, kind, operation_id, details, created_at: new Date(Date.UTC(2026, 9, 18, 12, 0, id)).toISOString() });
const op = (state: string, input: Record<string, unknown>) => ({
  operation_id: OP, kind: "search_video", request_id: OP, state, input, result: null, error: null,
  created_at: "2026-10-18T12:00:00Z", updated_at: "2026-10-18T12:00:00Z",
}) as never;

test("folds payment events and each operation into one step, in first-seen order", () => {
  const steps = groupSteps([
    ev(1, "quote.issued"), ev(2, "payment.verified"),
    ev(3, "operation.queued", OP), ev(4, "primitive.request_sent", OP), ev(5, "worker.launched", OP), ev(6, "operation.succeeded", OP),
  ], [op("succeeded", { query: "when does the timeout change?" })]);
  assert.deepEqual(steps.map((s) => [s.label, s.status, s.events.length]), [["Purchase", "done", 2], ["Search", "done", 4]]);
  assert.equal(steps[1].detail, "“when does the timeout change?”");
});

test("drops duplicate event ids from overlapping polls and reports failures", () => {
  const steps = groupSteps([ev(3, "operation.queued", OP), ev(3, "operation.queued", OP), ev(4, "operation.failed", OP)], [op("failed", {})]);
  assert.equal(steps[0].events.length, 2);
  assert.equal(steps[0].status, "failed");
});

test("an unpaid purchase stays active", () => {
  assert.equal(groupSteps([ev(1, "quote.issued"), ev(2, "payment.challenge")])[0].status, "active");
});

test("video-level events get product labels", () => {
  const P = "00000000-0000-4000-8000-0000000000b2";
  const steps = groupSteps([ev(1, "video.created"), ev(2, "video.probe_queued", P), ev(3, "operation.succeeded", P)]);
  assert.deepEqual(steps.map((s) => [s.label, s.status]), [["Upload", "done"], ["Verify media", "done"]]);
});
