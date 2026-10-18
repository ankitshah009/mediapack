import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
export const hmacHex = (key: string, data: string) => createHmac("sha256", key).update(data).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Deterministic UUID from arbitrary strings (used for idempotent ids). */
export function uuidFrom(...parts: string[]): string {
  const h = createHash("sha256").update(parts.join("\u0000")).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
