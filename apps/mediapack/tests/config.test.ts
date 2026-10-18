import assert from "node:assert/strict";
import { test } from "node:test";
import { integrationStatus, parseConfig } from "../src/config.js";

test("empty environment template values leave integrations unconfigured and keep health bootable", () => {
  const cfg = parseConfig({ DATABASE_URL: "", STRIPE_SECRET_KEY: " ", CAPABILITY_PEPPER: "", STRIPE_TIMEOUT_MS: "" });
  assert.equal(cfg.stripeTimeoutMs, 20000);
  assert.equal(integrationStatus(cfg).database, false);
  assert.equal(integrationStatus(cfg).stripe, false);
});

test("test-mode startup refuses a live merchant or profile", () => {
  assert.throws(() => parseConfig({ STRIPE_SECRET_KEY: "sk_live_test_fixture" }), /not a test-mode key/);
  assert.throws(() => parseConfig({ STRIPE_PROFILE_ID: "profile_live_fixture" }), /not a profile_test_/);
});
