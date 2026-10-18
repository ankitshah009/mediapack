import assert from "node:assert/strict";
import { test } from "node:test";
import { rootCertificates } from "node:tls";
import { integrationStatus, parseConfig, requireStripe } from "../src/config.js";

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

test("the internal MPP test network is explicit and cannot be used in live mode", () => {
  const key = "sk_test_config_fixture";
  const missing = parseConfig({ STRIPE_SECRET_KEY: key });
  assert.throws(() => requireStripe(missing), /STRIPE_PROFILE_ID/);
  assert.equal(integrationStatus(missing).stripe, false);
  const internal = parseConfig({ STRIPE_SECRET_KEY: key, STRIPE_TEST_NETWORK_ID: "internal" });
  assert.deepEqual(requireStripe(internal), { secretKey: key, networkId: "internal" });
  assert.equal(integrationStatus(internal).stripe, true);
  const profile = parseConfig({ STRIPE_SECRET_KEY: key, STRIPE_PROFILE_ID: "profile_test_fixture", STRIPE_TEST_NETWORK_ID: "internal" });
  assert.equal(requireStripe(profile).networkId, "profile_test_fixture");
  assert.throws(() => parseConfig({ PAYMENTS_MODE: "live", STRIPE_TEST_NETWORK_ID: "internal" }), /only with PAYMENTS_MODE=test/);
  assert.throws(() => parseConfig({ STRIPE_SECRET_KEY: "sk_live_fixture", STRIPE_TEST_NETWORK_ID: "internal" }), /not a test-mode key/);
  assert.throws(() => parseConfig({ STRIPE_TEST_NETWORK_ID: "arbitrary-network" }), /STRIPE_TEST_NETWORK_ID/);
});

test("an explicit database CA is decoded without weakening certificate verification", () => {
  const certificate = rootCertificates[0]!;
  const cfg = parseConfig({ DATABASE_CA_CERT_BASE64: Buffer.from(certificate).toString("base64") });
  assert.equal(cfg.databaseCaCert, certificate);
  assert.equal(parseConfig({ DATABASE_CA_CERT_BASE64: "" }).databaseCaCert, undefined);
});

test("malformed database CA settings fail with safe actionable configuration errors", () => {
  for (const value of ["invalid-encoding", Buffer.from("not-a-certificate").toString("base64"),
    Buffer.from("-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----").toString("base64")]) {
    assert.throws(() => parseConfig({ DATABASE_CA_CERT_BASE64: value }), error => {
      assert.match(String(error), /DATABASE_CA_CERT_BASE64.*trusted database CA/);
      assert.equal(String(error).includes(value), false);
      return true;
    });
  }
});

test("the demo buyer is off by default and carries documented daily caps", () => {
  assert.deepEqual(parseConfig({}).demoBuyer, { enabled: false, perClientDaily: 2, globalDaily: 100 });
  assert.deepEqual(parseConfig({ DEMO_BUYER_ENABLED: "", DEMO_BUYER_PER_CLIENT_DAILY: "", DEMO_BUYER_GLOBAL_DAILY: "" }).demoBuyer,
    { enabled: false, perClientDaily: 2, globalDaily: 100 });
  const tuned = parseConfig({ DEMO_BUYER_PER_CLIENT_DAILY: "1", DEMO_BUYER_GLOBAL_DAILY: "50" }).demoBuyer;
  assert.deepEqual([tuned.perClientDaily, tuned.globalDaily], [1, 50]);
  for (const bad of [{ DEMO_BUYER_PER_CLIENT_DAILY: "0" }, { DEMO_BUYER_GLOBAL_DAILY: "-1" }, { DEMO_BUYER_GLOBAL_DAILY: "1.5" }, { DEMO_BUYER_PER_CLIENT_DAILY: "many" }, { DEMO_BUYER_PER_CLIENT_DAILY: "3" }, { DEMO_BUYER_GLOBAL_DAILY: "101" }]) {
    assert.throws(() => parseConfig(bad), new RegExp(Object.keys(bad)[0]!));
  }
  assert.throws(() => parseConfig({ DEMO_BUYER_ENABLED: "yes" }), /DEMO_BUYER_ENABLED/);
});

test("the demo buyer is enabled only when the flag, test mode, a test key and the internal network all hold", () => {
  const all = { DEMO_BUYER_ENABLED: "true", PAYMENTS_MODE: "test", STRIPE_SECRET_KEY: "sk_test_config_fixture", STRIPE_TEST_NETWORK_ID: "internal" };
  assert.equal(parseConfig(all).demoBuyer.enabled, true);
  assert.equal(parseConfig({ ...all, STRIPE_SECRET_KEY: "rk_test_restricted_fixture" }).demoBuyer.enabled, true);
  assert.equal(parseConfig({ ...all, PAYMENTS_MODE: undefined }).demoBuyer.enabled, true, "PAYMENTS_MODE defaults to test");
  // Each missing condition keeps it off.
  assert.equal(parseConfig({ ...all, DEMO_BUYER_ENABLED: "false" }).demoBuyer.enabled, false);
  assert.equal(parseConfig({ ...all, DEMO_BUYER_ENABLED: undefined }).demoBuyer.enabled, false);
  assert.equal(parseConfig({ ...all, STRIPE_SECRET_KEY: undefined }).demoBuyer.enabled, false);
  assert.equal(parseConfig({ ...all, STRIPE_TEST_NETWORK_ID: undefined }).demoBuyer.enabled, false);
  // A merchant profile wins in requireStripe(), so challenges would not use the internal network: stay off.
  const profile = parseConfig({ ...all, STRIPE_PROFILE_ID: "profile_test_fixture" });
  assert.equal(requireStripe(profile).networkId, "profile_test_fixture");
  assert.equal(profile.demoBuyer.enabled, false);
  // Live mode can never enable it: the internal network and test keys are refused outright, and a live key alone is not enough.
  const live = parseConfig({ DEMO_BUYER_ENABLED: "true", PAYMENTS_MODE: "live", STRIPE_SECRET_KEY: "sk_live_config_fixture" });
  assert.equal(live.demoBuyer.enabled, false);
  assert.throws(() => parseConfig({ ...all, PAYMENTS_MODE: "live" }), /only with PAYMENTS_MODE=test/);
  assert.throws(() => parseConfig({ ...all, STRIPE_SECRET_KEY: "sk_live_config_fixture" }), /not a test-mode key/);
});
