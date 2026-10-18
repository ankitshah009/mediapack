// Primitive transport behind one adapter: SDK send (bodyText shape), official signature verifier.
import primitive, { verifyWebhookSignature } from "@primitivedotdev/sdk";
import { z } from "zod";
import { requirePrimitive, requirePrimitiveWebhookSecret, type Config } from "../config.js";

export interface OutgoingMail { to: string; from: string; subject: string; bodyText: string; idempotencyKey: string }

export interface PrimitiveAdapter {
  readonly controlAddress: string;
  readonly workerAddress: string;
  send(mail: Omit<OutgoingMail, "from" | "to"> & { to?: string }): Promise<{ id: string }>;
  /** Throws on a bad signature. rawBody must be the exact request bytes. */
  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined): void;
}

/** The subset of the email.received payload the control service relies on. */
export const InboundEmailEvent = z.object({
  id: z.string().min(1),
  event: z.string(),
  email: z.object({
    id: z.string().min(1),
    thread_id: z.string().nullish(),
    smtp: z.object({ rcpt_to: z.array(z.string()).default([]) }).partial().optional(),
    headers: z.object({
      message_id: z.string().nullish(),
      subject: z.string().nullish(),
      from: z.string().default(""),
      to: z.string().default(""),
    }),
    parsed: z.object({
      body_text: z.string().nullish(),
      in_reply_to: z.array(z.string()).nullish(),
    }).partial().optional(),
    auth: z.object({}).passthrough().optional(),
  }),
});
export type InboundEmailEvent = z.infer<typeof InboundEmailEvent>;

/** Bare address from `Name <a@b>` / `a@b`, lowercased. */
export function bareAddress(s: string): string {
  const m = /<([^>]+)>/.exec(s);
  return (m ? m[1]! : s).trim().toLowerCase();
}

export function createPrimitiveAdapter(cfg: Config): PrimitiveAdapter {
  let client: ReturnType<typeof primitive.client> | undefined;
  const cli = () => (client ??= primitive.client({ apiKey: requirePrimitive(cfg).apiKey }));
  return {
    get controlAddress() { return requirePrimitive(cfg).control; },
    get workerAddress() { return requirePrimitive(cfg).worker; },
    async send(mail) {
      const p = requirePrimitive(cfg);
      const res = await cli().send(
        { from: p.control, to: mail.to ?? p.worker, subject: mail.subject, bodyText: mail.bodyText },
        { idempotencyKey: mail.idempotencyKey, timeout: 15_000 },
      );
      return { id: res.id };
    },
    verifyWebhook(rawBody, signatureHeader) {
      verifyWebhookSignature({
        rawBody,
        signatureHeader: signatureHeader ?? "",
        secret: requirePrimitiveWebhookSecret(cfg),
      });
    },
  };
}

/** Pull a JSON object out of an email body (the reply helper may append quoted text). */
export function extractJson(text: string | null | undefined): unknown | undefined {
  if (!text) return undefined;
  const t = text.trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const start = t.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i]!;
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try { return JSON.parse(t.slice(start, i + 1)); } catch { return undefined; }
    }
  }
  return undefined;
}
