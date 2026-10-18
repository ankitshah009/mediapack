import assert from "node:assert/strict";
import { test } from "node:test";
import { launchErrorText } from "../src/services/inbox.js";

test("launch failures never persist as [object Object]", () => {
  assert.equal(launchErrorText(new Error("quota exceeded")), "quota exceeded");
  assert.equal(launchErrorText({ message: "sandbox capacity reached", status: 429 }), "sandbox capacity reached");
  assert.equal(launchErrorText({ status: 503 }), '{"status":503}');
  assert.equal(launchErrorText(null), "unknown provider error");
  assert.ok(launchErrorText({ error: "x".repeat(1000) }).length <= 300);
});
