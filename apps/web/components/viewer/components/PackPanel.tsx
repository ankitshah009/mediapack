import { useEffect, useState } from "react";
import { Api, type JobView, type PackView } from "../api/client";
import { toApiError } from "../api/hooks";
import { money, seconds, shortHash } from "../lib/format";
import { Badge, Card, Meter, Mono, SectionTitle } from "./ui";

export function AllowanceMeters({ job }: { job: JobView }) {
  const l = job.quote.limits;
  return (
    <Card aria-labelledby="allow-h">
      <SectionTitle id="allow-h" aside={job.pack_expires_at ? <span className="text-[11px] text-muted">pack ends {new Date(job.pack_expires_at).toLocaleString()}</span> : undefined}>
        Allowance
      </SectionTitle>
      <div className="flex flex-col gap-3">
        <Meter label="Searches" used={job.used.searches} reserved={job.reserved.searches} total={l.searches} />
        <Meter label="Frames" used={job.used.frames} reserved={job.reserved.frames} total={l.frames} />
        <Meter label="Clip time" used={Math.round(job.used.clip_ms / 1000)} reserved={Math.round(job.reserved.clip_ms / 1000)} total={Math.round(l.clip_ms / 1000)} unit="s" />
        <Meter label="Evidence text" used={job.used.text_chars} reserved={job.reserved.text_chars} total={l.text_chars} unit=" chars" />
      </div>
      <p className="mt-2 text-[11px] text-muted">Orange is reserved by work in flight. {job.remaining.searches} searches, {job.remaining.frames} frames, {seconds(job.remaining.clip_ms)} clip left.</p>
    </Card>
  );
}

/** Receipt only for a payment the service marked paid (verified against Stripe server-side). */
export function ReceiptPanel({ job }: { job: JobView }) {
  const [pack, setPack] = useState<PackView>();
  const [err, setErr] = useState<string>();
  const paid = job.payment_state === "paid";
  const opsDone = job.operations.filter((o) => o.state === "succeeded").length;
  useEffect(() => {
    if (!paid) return;
    let live = true;
    Api.pack(job.job_id)
      .then((p) => live && (setPack(p), setErr(undefined)))
      .catch((e) => live && setErr(toApiError(e).message));
    return () => {
      live = false;
    };
  }, [job.job_id, paid, opsDone]);

  if (!paid) {
    return (
      <Card aria-labelledby="rcpt-h">
        <SectionTitle id="rcpt-h">Pack and receipt</SectionTitle>
        <p className="text-sm text-muted">
          {job.payment_state === "reconciling" ? "A receipt appears once Stripe confirms the payment." : "No receipt yet: this quote is unpaid."}
        </p>
      </Card>
    );
  }
  const q = job.quote;
  const artifacts = pack?.artifacts ?? [];
  return (
    <Card aria-labelledby="rcpt-h">
      <SectionTitle id="rcpt-h" aside={<Badge tone="ok">Verified {q.payment_mode === "test" ? "test " : ""}payment</Badge>}>
        Pack and receipt
      </SectionTitle>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted">Amount</dt><dd>{money(q.amount_minor, q.currency)}</dd>
        <dt className="text-muted">Mode</dt><dd>Stripe {q.payment_mode}</dd>
        <dt className="text-muted">PaymentIntent</dt><dd><Mono>{job.payment_intent_id}</Mono></dd>
        {job.paid_at && (<><dt className="text-muted">Paid</dt><dd>{new Date(job.paid_at).toLocaleString()}</dd></>)}
        {job.pack_expires_at && (<><dt className="text-muted">Pack expires</dt><dd>{new Date(job.pack_expires_at).toLocaleString()}</dd></>)}
      </dl>

      <div className="mt-4 border-t border-line pt-3">
        <p className="text-sm font-medium">Manifest</p>
        {err && <p className="text-xs text-danger" role="alert">Could not load the manifest: {err}</p>}
        {!pack && !err && <p className="text-xs text-muted">Loading manifest…</p>}
        {pack && (
          <>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted">Source SHA-256</dt><dd><Mono>{shortHash(pack.source_sha256 ?? q.source_sha256, 16)}</Mono></dd>
              <dt className="text-muted">Indexer</dt><dd><Mono>{pack.indexer_version ?? q.indexer_version}</Mono></dd>
              <dt className="text-muted">Artifacts</dt><dd>{artifacts.length}</dd>
            </dl>
            {artifacts.length > 0 && (
              <details className="mt-2 text-xs">
                <summary className="cursor-pointer text-muted">Artifacts and hashes</summary>
                <ul className="mt-2 flex flex-col gap-2">
                  {artifacts.map((a) => (
                    <li key={a.artifact_id} className="rounded-lg border border-line p-2">
                      <p><Badge>{a.kind}</Badge> <span className="font-mono">{a.actual_ms.start}{a.actual_ms.end != null ? `–${a.actual_ms.end}` : ""} ms</span></p>
                      <p className="mt-1 text-muted">artifact <Mono>{a.artifact_id}</Mono></p>
                      <p className="text-muted">sha256 <Mono>{a.sha256}</Mono></p>
                      <p className="text-muted">source <Mono>{shortHash(a.source_sha256, 16)}</Mono></p>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer text-muted">Raw manifest JSON</summary>
              <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-code p-2 font-mono text-[11px] text-rail-text" tabIndex={0}>{JSON.stringify(pack, null, 2)}</pre>
            </details>
          </>
        )}
      </div>
    </Card>
  );
}
