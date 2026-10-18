# Build decisions (lead). Read with BUILD_PLAN.md + CONTRACTS.md. Where they conflict, this file wins.

## Locked
- App: `apps/web` is the Next.js App Router dashboard and REST/webhook API, hosted on Blaxel. This follows the user's explicit requirement and supersedes the Vite/Hono hosting choice in BUILD_PLAN.md.
- Hosting: Blaxel sandbox with a public preview on port 3000, running the compiled standalone server. The workspace's Applications private-preview entitlement is unavailable; the user's preference to keep hosting on Blaxel takes precedence. `scripts/host-blaxel.mjs` sets the real preview origin before startup. Per the user's cost requirement, the 2048 MiB web host has `keepAlive: false` (automatic standby allowed) and a `ttl-idle: 1h` deletion policy, enforced even on reused sandboxes. Deletion removes the preview URL; rerun the script to recreate it and update callback/Manufact URLs if changed. Blaxel counts idle-policy activity at resume/suspend, so a continuously active session can also expire after one hour. This is sandbox hosting, without Application revision management.
- MCP: `apps/mcp` is the mcp-use 2.10.1 thin REST proxy, hosted on Manufact. It forwards each caller's capability to the Next.js API; it does not own payment or allowance state.
- Shared backend services: `apps/mediapack/src`; `buildHttpApp` is mounted in-process by Next.js Node route handlers. No second control-service listener is required. The old combined MCP/Vite server remains a development reference, not the primary app.
- Media compute: the bounded Node/ffmpeg worker runs in Blaxel at 4096 MiB (4 GB), separately from the 2048 MiB Next.js host. The actual `workerLaunchSpec` and `worker/blaxel.toml` both request 4096 MiB; this follows the user's explicit upgrade for local transcription headroom. Primitive carries real work requests and results. Local Whisper integration is still pending; the memory upgrade alone does not install it.
- DB access from the control service: **direct Postgres** via npm `postgres` (porsager) using `DATABASE_URL`
  (Supabase pooled connection string). Reason: real transactions + SQL helpers, and testable against local Postgres
  (`scripts/test-db.sh`). Storage uses `@supabase/supabase-js` with the service role (server only).
- Schema + transaction helpers: `supabase/migrations/0001_init.sql` — 42 invariants pass (`bash scripts/test-db.sh`).
  Call the helpers; don't reimplement their logic in TS. New SQL goes in `0002_*.sql` + tests.
- Shared wire types: `apps/mediapack/src/contracts/index.ts`. Change only via the lead.
- Models: OpenAI Responses (`OPENAI_VISION_MODEL`, default `gpt-5.4-mini`) for frame observation + search; `whisper-1`
  verbose_json segment timestamps. Both behind `src/adapters/models.ts`-style interfaces in the worker.
- No vectors. Search = one bounded model call over stored `index_records` text, citing record IDs; server resolves times.

## Topology (one Primitive org-wide webhook → `/webhooks/primitive`)
1. Control commits an operation + outbox row (SQL helper). Outbox dispatcher sends Primitive mail
   `control@` → `worker@`, body = WorkRequest JSON, Idempotency-Key = outbox.idempotency_key.
2. Primitive delivers that inbound mail to `/webhooks/primitive`. Control verifies signature, inserts provider_events
   (dedupe), sees recipient/subject = work request, then `claim_operation` and launches the Blaxel process
   ("launch after verified work delivery"). The manifest includes `reply_email_id` (the inbound email id).
3. Worker process (Blaxel sandbox, named per operation+generation, `keepAlive: true`, bounded timeout) runs
   `node dist/run.js`, uses a scoped worker token to get signed URLs from
   `POST /internal/operations/:id/artifact-access`, writes artifacts, then replies through Primitive to
   `reply_email_id` with the WorkResult JSON (Idempotency-Key `mp:<op>:result:<gen>`).
4. The reply lands at `/webhooks/primitive` → control validates (generation, artifact keys under the op prefix,
   hashes), inserts `artifacts`/`index_records`, calls `complete_operation` / `fail_or_retry_operation`.
- Subject format: `[mp:<operation_id>:g<generation>] <action>` (and `Re: …` for results). Body JSON is authoritative.
- Artifact keys: `<video_id>/source.<ext>` (source), `<video_id>/ops/<operation_id>/g<gen>/<name>` (derived).

## Trimmed for the deadline (designed, documented, not built)
- Supabase Cron/pg_net: `/internal/tick` exists and is called opportunistically after commits and by `scripts/tick`;
  scheduling it via Cron is a documented one-liner, done only if time allows.
- Resumable (TUS) upload: 100 MiB cap → standard signed upload URL (`createSignedUploadUrl`).
- Refunds: manual; UI never shows "refunded".
- Rate limiting: per-client unpaid-upload cap (3) + global unpaid cap via SQL count; no IP limiter.

## Ownership (parallel workstreams)
- Control (A): `apps/mediapack/{index.ts, src/config.ts, src/db.ts, src/services/**, src/routes/**, src/tools/**,
  src/adapters/{primitive,stripe,storage}.ts}`, `scripts/` (CLI), `apps/mediapack/tests/**`, `.env.example`.
- Worker (B): `worker/**` (Node/TS; replace the abandoned Python files), `apps/mediapack/src/adapters/blaxel.ts`.
- UI (C): `apps/mediapack/app/**` (Vite, base `/app/`), `apps/mediapack/views/**`.
- Lead: contracts, migrations, DECISIONS.md, integration + demo.
