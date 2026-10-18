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
