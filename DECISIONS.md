# Build decisions (lead). Read with BUILD_PLAN.md + CONTRACTS.md. Where they conflict, this file wins.

## Locked

- App: `apps/web` is the Next.js App Router dashboard and REST/webhook API, hosted on Blaxel. This follows the user's explicit requirement and supersedes the Vite/Hono hosting choice in BUILD_PLAN.md.
- Hosting: Blaxel sandbox with a public preview on port 3000, running the compiled standalone server. The workspace's Applications private-preview entitlement is unavailable; the user's preference to keep hosting on Blaxel takes precedence. `scripts/host-blaxel.mjs` sets the real preview origin before startup. The 2048 MiB web host retains `keepAlive: false`, allowing automatic standby. The helper defaults to one-hour idle deletion; the current judging host explicitly uses `--idle-ttl 24h`, with the `ttl-idle: 24h` delete policy read back from Blaxel. This is separate from the purchased pack's 24-hour entitlement. Deletion removes the preview URL; recreate the host and update callbacks/Manufact if the origin changes. Blaxel counts policy activity at resume/suspend transitions, so continuous activity can also reach the configured deadline. Standby stops active compute charges; snapshot/image storage remains billed. This is sandbox hosting, without Application revision management.
- MCP: `apps/mcp` is the mcp-use 2.10.1 thin REST proxy, hosted on Manufact. It forwards each caller's capability to the Next.js API; it does not own payment or allowance state.
- Shared backend services: `apps/mediapack/src`; `buildHttpApp` is mounted in-process by Next.js Node route handlers. No second control-service listener is required. The old combined MCP/Vite server remains a development reference, not the primary app.
- Media compute: the bounded Node/ffmpeg worker runs in Blaxel at 4096 MiB (4 GB), separately from the 2048 MiB Next.js host. `workerLaunchSpec` and `worker/blaxel.toml` both request 4096 MiB. The deployed image packages checksum-pinned whisper.cpp 1.9.5 and the multilingual base model for local ASR. An actual 4 GB cloud smoke transcribed 7.618 seconds of source audio in 44.864 seconds; this is a measured short-input result, not a general indexing-latency promise. Workers retain a 30-minute sandbox TTL and bounded process execution. Primitive carries real work requests and results.
- DB access from the control service: **direct Postgres** via npm `postgres` (porsager) using `DATABASE_URL`
  (Supabase pooled connection string). Reason: real transactions + SQL helpers, and testable against local Postgres
  (`scripts/test-db.sh`). Storage uses `@supabase/supabase-js` with the service role (server only).
- Supabase plan: **Free**, as chosen by the user. Source uploads are limited to 50 MiB (52,428,800 bytes) across browser, REST, MCP, CLI, worker and the configured private bucket. Database connections verify the provider CA strictly through `DATABASE_CA_CERT_BASE64`. Keep Stripe payments in test mode; Stripe Projects' infrastructure authorization is separate.
- Schema + transaction helpers: `supabase/migrations/0001_init.sql` and `0002_worker_launch_events.sql` both applied successfully to a fresh database, with all 42 invariants passing (`bash scripts/test-db.sh`). Call the helpers; do not reimplement their logic in TS. New SQL uses the next numbered migration plus tests.
- Shared wire types: `apps/mediapack/src/contracts/index.ts`. Change only via the lead.
- Models: the current frame-observation/search configuration is `gpt-4o-mini` through `OPENAI_BASE_URL=https://run.blaxel.ai/mediapack/models/sandbox-openai/v1`. Local `WhisperCppAsr` is the production speech path; the gateway's unavailable audio-transcription endpoint is not used. Model names remain configurable behind the worker interfaces; the optional direct OpenAI adapter is separate from the current gateway configuration.
- Runtime credentials: the control server keeps persistent `BL_CLIENT_CREDENTIALS` and `BL_WORKSPACE`; OAuth mints a fresh short-lived model token for each index/search launch. Only that token enters the model worker. Media-only actions receive no model credentials. Persistent workspace API-key authentication is rejected for gateway forwarding, and persistent service-account credentials never enter worker manifests. Local native CLI login is provisioning authentication, not the deployed server's runtime credential.
- Sandbox commerce: the configured merchant explicitly uses `STRIPE_TEST_NETWORK_ID=internal` with `PAYMENTS_MODE=test`; the buyer requires its own test key and `MPPX_STRIPE_TEST_NETWORK_ID=internal`. A real isolated MPP 402 → token → receipt 200 round trip verified a 50-minor-unit USD 0.50 test payment. No public merchant profile is fabricated; Link/public-wallet use still requires an actual Stripe profile. The normal test-profile path remains supported. The buyer permits one reduced test-helper request only after definitive HTTP 400 `parameter_unknown` for optional seller details/metadata; timeouts and other uncertain outcomes never trigger that fallback.
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

## Delivered recovery

- `scripts/setup-recovery.mjs` owns the installed private Supabase Cron/pg_net schedule, due-work predicates, replay-nonce table and Vault secrets. It sends timestamp/nonce/HMAC-signed `/internal/tick` requests only when database work is due. The scheduled pg_net headers contain no reusable static bearer token. A real missed-inline-dispatch recovery completed in 34.6 seconds. The final r7 recovery proof passed all 12 checks: fresh signed requests returned 200, replayed or tampered requests returned 401, and 300-second nonce retention was verified. A 70.493-second idle observation covered two cron runs with zero HTTP requests. Rerun the helper's `--apply` after changing the active host origin or signing token. Inline dispatch and the intentional one-off operator tick remain available.

## Current hosted runtime (2026-10-18)

- Web: `mediapack-web-r7`, image `sandbox/mediapack-web:b355ba20b80085378c07c`, [dashboard](https://b45bc8809f4a40e5dad83cb402719f89.preview.bl.run/app). Database is OK and the host reports no missing provider settings; readiness, disabled keep-alive and the 24-hour delete policy were verified. The active worker image remains `sandbox/mediapack-worker:be53b19cc608a18554956`. R7 changes only narrow-screen status-URL wrapping; backend, worker, payments and evidence remain unchanged. Final r7 proxy readback and deployed browser checks passed. Both Sandbox buyer and Link tabs fit at 375 and 1280 pixels; keyboard access, current-origin commands and payment/memory disclosures passed, with all 40 checked assets returning 200 and no browser errors. Owned Stripe and Primitive callbacks on r7 passed signature persistence and duplicate-event handling checks.
- Manufact: [MCP endpoint](https://fast-wave-awovc.run.mcp-use.com/mcp), whose source-specific search and evidence proof completed through r6; the public MCP URL is stable. The final read-only r7 `get_job`/`get_pack` readback passed, preserving the correct search and four frame/two clip hash references with zero new operations or usage changes. All nine MCP tools were available and viewer assets returned HTTP 200. Search operation `0a6e266a-1a49-4d88-861c-96865c2575e5` referenced supported records `f21`/`f24` over 40–48 seconds, observing 30 after reload versus 60 saved. Its exported source frames and eight-second clip are verified: at 40,000 ms the frame shows 60 and Saved; at 46,000 ms it shows 30. The 40,000–48,000 ms H.264 clip is 1280×800, fully decoded with ffmpeg exit zero, and all downloaded SHA-256 values match.
- Primitive delivery is enabled, with signed-event persistence and duplicate-event handling verified. The paid talk-recording flow completed upload/preflight, sandbox purchase, Primitive work/result, indexing/search and evidence retrieval. The final backend suite passed 65 tests and the worker suite passed 39, including actual local Whisper checks. Both paid source flows completed on r6. The final settings proof passed 15/15 checks with actual 4 GB worker-image execution and applied Primitive requests/results. It has one entitlement/payment attempt/PaymentIntent/index operation; exact replays leave the ledger unchanged. Delivered usage is three searches, four frames, 14 seconds of clips and 834 text characters, with zero reservations. Its 40–48-second evidence differs from the talk source's 22–31.44-second evidence. The next normal frame launch reaped the completed search worker from STANDBY to TERMINATED. `docs/verification.md` and the release checklist retain the detailed proofs.

## Remaining deadline cuts

- Resumable (TUS) upload: 50 MiB cap → standard signed upload URL (`createSignedUploadUrl`).
- Refunds: manual; UI never shows "refunded".
- Rate limiting: per-client unpaid-upload cap (3) + global unpaid cap via SQL count; no IP limiter.

## Ownership (parallel workstreams)

- Control (A): `apps/mediapack/{index.ts, src/config.ts, src/db.ts, src/services/**, src/routes/**, src/tools/**,
  src/adapters/{primitive,stripe,storage}.ts}`, `scripts/` (CLI), `apps/mediapack/tests/**`, `.env.example`.
- Worker (B): `worker/**` (Node/TS + ffmpeg + local whisper.cpp), `apps/mediapack/src/adapters/blaxel-launch.ts`.
- UI (C): `apps/web/app/**`, `apps/web/components/**` (Next.js dashboard, base `/app/`). The deployed thin MCP proxy is `apps/mcp/**`.
- Lead: contracts, migrations, DECISIONS.md, integration + demo.
