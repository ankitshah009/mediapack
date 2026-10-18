import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { verifyTickSignature } from "../src/services/tick-auth.js";

const SECRET = "dummy-recovery-tick-test-key-only";
const NOW_SECONDS = 1_792_307_200;
const NOW_MS = NOW_SECONDS * 1000;
const NONCE = "afabcbde-1234-4567-890a-0123456789ab";
const sign = (timestamp = String(NOW_SECONDS), nonce = NONCE, secret = SECRET) => ({
  timestamp, nonce,
  signature: createHmac("sha256", secret).update(`mediapack-tick-v1\n${timestamp}\n${nonce}`).digest("hex"),
});

test("a correctly signed tick returns only its canonical nonce and integer epoch timestamp", () => {
  assert.deepEqual(verifyTickSignature(SECRET, sign(), NOW_MS), { nonce: NONCE, timestamp: NOW_SECONDS });
});

test("the 90-second validity window includes both boundaries and rejects older or further-future ticks", () => {
  for (const offset of [-90, 0, 90]) {
    assert.ok(verifyTickSignature(SECRET, sign(String(NOW_SECONDS + offset)), NOW_MS), `offset ${offset} is in the validity window`);
  }
  for (const offset of [-91, 91]) {
    assert.equal(verifyTickSignature(SECRET, sign(String(NOW_SECONDS + offset)), NOW_MS), undefined, `offset ${offset} is outside the validity window`);
  }
  assert.ok(verifyTickSignature(SECRET, sign(String(NOW_SECONDS - 90)), NOW_MS + 999), "epoch seconds are used consistently within the current second");
});

test("tampering with the timestamp, nonce, signature or signing key invalidates a tick", () => {
  const signed = sign();
  assert.equal(verifyTickSignature("wrong-key", signed, NOW_MS), undefined);
  assert.equal(verifyTickSignature(SECRET, { ...signed, timestamp: String(NOW_SECONDS + 1) }, NOW_MS), undefined);
  assert.equal(verifyTickSignature(SECRET, { ...signed, nonce: "bfabcbde-1234-4567-890a-0123456789ab" }, NOW_MS), undefined);
  assert.equal(verifyTickSignature(SECRET, { ...signed, signature: `${signed.signature[0] === "0" ? "1" : "0"}${signed.signature.slice(1)}` }, NOW_MS), undefined);
});

test("a future-boundary signature remains valid through 180999 ms and its nonce must outlive that window", () => {
  const signed = sign(String(NOW_SECONDS + 90));
  assert.ok(verifyTickSignature(SECRET, signed, NOW_MS));
  assert.ok(verifyTickSignature(SECRET, signed, NOW_MS + 180_999));
  assert.equal(verifyTickSignature(SECRET, signed, NOW_MS + 181_000), undefined);
});

test("signatures are scoped to the exact recovery-tick protocol and newline framing", () => {
  const signed = sign();
  for (const payload of [
    `${signed.timestamp}\n${signed.nonce}`,
    `mediapack-tick-v2\n${signed.timestamp}\n${signed.nonce}`,
    `mediapack-tick-v1:${signed.timestamp}:${signed.nonce}`,
    `mediapack-tick-v1\n${signed.timestamp}\n${signed.nonce}\n`,
  ]) {
    const signature = createHmac("sha256", SECRET).update(payload).digest("hex");
    assert.equal(verifyTickSignature(SECRET, { ...signed, signature }, NOW_MS), undefined);
  }
});

test("missing signature fields and noncanonical UUID or hex encodings fail closed", () => {
  const signed = sign();
  for (const field of ["timestamp", "nonce", "signature"] as const) {
    assert.equal(verifyTickSignature(SECRET, { ...signed, [field]: undefined }, NOW_MS), undefined);
    assert.equal(verifyTickSignature(SECRET, { ...signed, [field]: "" }, NOW_MS), undefined);
  }
  for (const nonce of [NONCE.toUpperCase(), NONCE.replaceAll("-", ""), ` ${NONCE}`, `${NONCE}\n`, "not-a-uuid"]) {
    assert.equal(verifyTickSignature(SECRET, sign(String(NOW_SECONDS), nonce), NOW_MS), undefined);
  }
  for (const signature of [signed.signature.toUpperCase(), signed.signature.slice(0, 63), `${signed.signature}0`, "g".repeat(64), ` ${signed.signature}`, `${signed.signature}\n`]) {
    assert.equal(verifyTickSignature(SECRET, { ...signed, signature }, NOW_MS), undefined);
  }
});

test("timestamps require canonical unsigned epoch seconds even when the supplied value was signed", () => {
  for (const timestamp of [
    `0${NOW_SECONDS}`, `${NOW_SECONDS}.0`, `+${NOW_SECONDS}`, ` ${NOW_SECONDS}`, `${NOW_SECONDS}\n`,
    "1.7923072e9", "NaN", "Infinity", "-1", "9999999999999",
  ]) {
    assert.equal(verifyTickSignature(SECRET, sign(timestamp), NOW_MS), undefined, `timestamp ${JSON.stringify(timestamp)} must fail closed`);
  }
});
