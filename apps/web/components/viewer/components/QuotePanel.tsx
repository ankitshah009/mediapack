import { useEffect, useState } from "react";
import type { JobView } from "../api/client";
import { countdown, money, seconds, shortHash } from "../lib/format";
import { Badge, Button, Card, Mono, SectionTitle } from "./ui";

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function purchaseUrl(job: JobView): string {
  const u = job.quote.purchase_url;
  return u.startsWith("/") ? `${window.location.origin}${u}` : u;
}

/** Placeholders only — a real token or key is never rendered. */
export function payCommands(job: JobView) {
  const url = purchaseUrl(job);
  const command = `node scripts/mediapack.mjs buy ${job.job_id} --url '${new URL(url).origin}'`;
  return {
    mppx: `MPPX_STRIPE_TEST_NETWORK_ID=internal ${command} --via mppx`,
    link: `${command} --via link`,
  };
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="secondary"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked: the text is selectable below */
        }
      }}
    >
      {done ? "Copied" : "Copy"}
    </Button>
  );
}

export function PaymentStateBadge({ job }: { job: JobView }) {
  if (job.payment_state === "paid") return <Badge tone="ok">Paid</Badge>;
  if (job.payment_state === "reconciling") return <Badge tone="stripe">Reconciling</Badge>;
  return <Badge tone="neutral">Unpaid</Badge>;
}

export function QuotePanel({ job, onNewQuote, busy }: { job: JobView; onNewQuote: () => void; busy?: boolean }) {
  const now = useNow();
  const q = job.quote;
  const cd = countdown(q.expires_at, now);
  const expired = cd.expired && job.payment_state === "unpaid";
  const cmds = payCommands(job);
  const [tab, setTab] = useState<"mppx" | "link">("mppx");
  return (
    <Card aria-labelledby="quote-h" className="border-stripe/30">
      <SectionTitle
        id="quote-h"
        aside={
          <div className="flex items-center gap-2">
            <Badge tone="stripe">Stripe {q.payment_mode} mode</Badge>
            <PaymentStateBadge job={job} />
          </div>
        }
      >
        Quote
      </SectionTitle>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <p className="font-display text-3xl font-semibold tracking-tight">{money(q.amount_minor, q.currency)}</p>
        <p className="text-sm text-muted">
          one pack for this video · valid {Math.round(q.pack_ttl_seconds / 3600)}h after payment
        </p>
      </div>
      <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="What the pack includes">
        <li><Badge>Indexing</Badge></li>
        <li><Badge>{q.limits.searches} searches</Badge></li>
        <li><Badge>{q.limits.frames} frames</Badge></li>
        <li><Badge>{seconds(q.limits.clip_ms)} of clips</Badge></li>
        <li><Badge>{q.limits.text_chars.toLocaleString()} chars of evidence text</Badge></li>
      </ul>

      {job.payment_state === "unpaid" && (
        <p className={`mt-3 text-sm ${expired ? "font-medium text-danger" : "text-muted"}`} role="timer">
          {expired ? "Quote expired. Nothing was charged." : `Quote expires ${new Date(q.expires_at).toLocaleTimeString()} · ${cd.text}`}
        </p>
      )}

      {job.payment_state === "reconciling" && (
        <div role="status" className="mt-4 rounded-xl border border-stripe/40 bg-stripe-soft p-3 text-sm">
          <p className="font-medium text-stripe">Payment is reconciling</p>
          <p className="mt-0.5">
            Stripe has not confirmed the outcome yet. Do not pay again; this page updates as soon as the payment is
            verified or released.
          </p>
        </div>
      )}

      {job.payment_state === "paid" && (
        <p className="mt-3 text-sm">
          Verified Stripe {q.payment_mode} payment <Mono>{job.payment_intent_id}</Mono>
        </p>
      )}

      {job.payment_state === "unpaid" && !expired && (
        <div className="mt-4">
          <div role="tablist" aria-label="Payment method" className="inline-flex rounded-lg bg-line p-0.5">
            {([["mppx", "Sandbox buyer (default)"], ["link", "Link agent wallet"]] as const).map(([id, label]) => (
              <button
                key={id}
                role="tab"
                id={`tab-${id}`}
                aria-selected={tab === id}
                aria-controls="pay-panel"
                type="button"
                onClick={() => setTab(id)}
                className={`min-h-9 rounded-md px-3 text-xs font-medium ${tab === id ? "bg-card shadow-sm" : "text-muted"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div id="pay-panel" role="tabpanel" aria-labelledby={`tab-${tab}`} className="mt-3">
            <p className="text-sm">
              {tab === "mppx"
                ? "From the cloned MediaPack repository, use the agent’s paired CLI client and its privately configured Stripe test key:"
                : "Link requires an authenticated agent wallet and a merchant with a real Stripe profile. This demo’s internal sandbox network uses the default sandbox buyer."}
            </p>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-xl bg-code p-3 font-mono text-[12px] leading-relaxed text-rail-text" tabIndex={0} aria-label="Payment command">
              {tab === "mppx" ? cmds.mppx : cmds.link}
            </pre>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <CopyButton text={tab === "mppx" ? cmds.mppx : cmds.link} label="Copy payment command" />
              <span className="text-xs text-muted">Use the same CLI client that owns this video; pair this browser with that client.</span>
            </div>
            {tab === "mppx" && (
              <div className="mt-3">
                <p className="text-xs text-muted">
                  Set <code>MPPX_STRIPE_SECRET_KEY</code> privately in your terminal first. The command explicitly
                  selects this demo’s internal Stripe test network. No real funds are charged.
                </p>
              </div>
            )}
            <p className="mt-2 text-xs text-muted">This page does not pay. It updates when Stripe confirms.</p>
          </div>
        </div>
      )}

      {expired && (
        <Button className="mt-4" variant="primary" busy={busy} onClick={onNewQuote}>
          Request a fresh quote
        </Button>
      )}

      <details className="mt-4 text-xs text-muted">
        <summary className="cursor-pointer">Quote details</summary>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt>Quote</dt><dd><Mono>{q.quote_id}</Mono></dd>
          <dt>Source SHA-256</dt><dd><Mono>{q.source_sha256}</Mono></dd>
          <dt>Terms hash</dt><dd><Mono title={q.terms_hash}>{shortHash(q.terms_hash, 16)}</Mono></dd>
          <dt>Indexer</dt><dd><Mono>{q.indexer_version}</Mono></dd>
        </dl>
      </details>
    </Card>
  );
}
