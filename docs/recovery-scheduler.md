# Durable recovery with idle cost protection

`scripts/setup-recovery.mjs` installs one Supabase Cron job, `mediapack-recovery-v1`. Every minute it runs a private database function. That function sends a request to the Blaxel host only when persisted work is due. An empty or completed workload produces no HTTP request and allows the web sandbox to enter standby.

Run from the repository root after the app migrations and deployed provider credentials are verified:

```sh
node scripts/setup-recovery.mjs --plan
node scripts/setup-recovery.mjs --apply
```

The default private settings file is `apps/web/.env.blaxel`. It requires `DATABASE_URL`, the same stable `INTERNAL_TICK_TOKEN` used by the deployed app, and the official CA bundle in `DATABASE_CA_CERT_BASE64` when the database requires that CA. Certificate verification stays enabled. Credentials are read from the file, never command arguments or printed output.

The target origin comes from `.blaxel/web-host.json`. After recreating the sandbox, run the host helper first and then rerun recovery `--plan` and `--apply`; this updates only the scheduler's owned origin secret. An explicit `--origin https://current-host.example` overrides that file. The helper never changes a billing plan.

## When the scheduler wakes the app

These conditions match the existing `/internal/tick` implementation and its SQL helpers:

| Persisted condition | Recovery |
| --- | --- |
| Running operation with an expired worker lease | Reap and use the existing retry/failure path. |
| Expired upload in uploading, probing, or ready state, without a paid job, live quote, or unresolved/succeeded payment attempt | Mark expired and remove source storage through the app. |
| Paid pack past expiry in ready, paid, or indexing state | Mark the pack expired. |
| Primitive `email.received` event in received/error state, older than 30 seconds, with fewer than five attempts | Reprocess the verified persisted delivery. |
| Submitting/unknown payment attempt older than 60 seconds | Reconcile with Stripe without submitting another charge. |
| Unsent outbox row whose retry time is due and whose send lease is absent or expired | Claim and retry the durable send. |

Valid worker leases, completed work, future retry times, and unexpired uploads do not wake Blaxel. Unresolved persisted work continues to request recovery once per minute until resolved; the idle protection does not discard a pending payment or silently abandon an operation.

## Authentication and ownership

The permanent tick token and host origin are stored in Supabase Vault under scheduler-specific names. The cron command is only `select mediapack_setup.dispatch_recovery_tick();`; it contains no credential or origin.

Supabase documents that database roles can inspect request headers temporarily queued by pg_net. For this reason the scheduler never queues a permanent bearer token. It sends three headers:

- `x-mediapack-tick-timestamp`: integer Unix seconds.
- `x-mediapack-tick-nonce`: a fresh UUID.
- `x-mediapack-tick-signature`: lowercase HMAC-SHA256 hex over `mediapack-tick-v1\n{timestamp}\n{nonce}`, using the UTF-8 tick token.

The deployed route validates the signature and its 90-second age bound, then atomically records the nonce in the private `mediapack_setup.recovery_nonces` table for 300 seconds. Replays are rejected. The setup helper creates that table with an expiry index and RLS, and revokes access from public/browser/service roles. Cron functions use invoker rights with a fixed `pg_catalog` search path; no new elevated function is introduced.

The helper checks ownership markers before replacing functions, secrets, the nonce table, or the named schedule. Unrelated resources remain unchanged. Extension activation, infrastructure objects, Vault changes, and the schedule are committed in one transaction. Repeated apply reuses the same cron job and only updates changed owned secret values. Read-only plan does not activate extensions, send HTTP, or contact Stripe, Primitive, or models.

## Verification and limits

```sh
node --test scripts/setup-recovery.test.mjs
MEDIAPACK_TEST_LOCAL_POSTGRES=1 node --test scripts/setup-recovery.test.mjs
```

The second command needs the installed PostgreSQL 17 binaries, or `PG_BIN`. It applies the actual app migration to a disposable database, checks eligible/ineligible cases for all six predicates, proves an idle dispatch sends nothing, and verifies an actual SQL-generated HMAC against Node's implementation. Only network/DB I/O edges are mocked in the setup control-flow tests.

On October 18, the recovery setup was applied to the existing Supabase Free database, enabling the minute schedule with its SQL due-work predicate. A fresh signed request returned 200 from the hosted route; replay returned 401. The actual idle dispatch returned NULL and queued no HTTP request. A real committed operation whose immediate dispatch was deliberately missed then recovered through the minute cron in 34.585 seconds, and the next idle cron run queued zero HTTP. All 13 checks passed; private evidence is retained in `.blaxel/recovery-interruption-proof.json`. This proves interrupted-dispatch recovery and idle cost protection. R6 scheduler-origin reapply succeeded with the Vault target and active schedule verified. A fresh signed tick returned 200, replay and tamper returned 401, and 300-second nonce retention was read back. A 71-second actual cron observation queued zero idle HTTP, completing all 12 r6 checks. R7 origin reapply and all 12 fresh checks also passed: the signed tick returned 200, replay and tamper returned 401, 300-second nonce retention was verified, and a 70.493-second observation covered two successful cron runs with zero idle HTTP. These r7 checks independently verify the current origin.

The outbound HTTP timeout is 55 seconds. pg_net's queue is unlogged; a crash can lose an enqueued request, but persisted eligibility remains and the next cron run can recover it. Cron requires an available Supabase database. It cannot recreate a deleted Blaxel sandbox: expiry removes the preview URL (the helper defaults to 1h; the current judging host uses a verified 24h idle policy with standby still allowed), so the host must be recreated and this scheduler's origin updated before it can recover work again.

To inspect runs without exposing queued headers or decrypted secrets, use the Supabase Cron dashboard for `mediapack-recovery-v1` and the helper's read-only plan. The plan reports booleans for due-work reasons and extension status. Do not print Vault contents or pg_net request headers.

Official references: [Cron](https://supabase.com/docs/guides/cron), [scheduled HTTP functions and Vault](https://supabase.com/docs/guides/functions/schedule-functions), [pg_net API and limitations](https://supabase.com/docs/guides/database/extensions/pg_net), [queued-header visibility](https://supabase.com/docs/guides/troubleshooting/database-roles-can-read-request-headers-queued-by-pg_net-ad6357), [Vault secret create/update API](https://supabase.com/docs/guides/database/vault).
