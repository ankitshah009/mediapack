# Account setup and remaining release steps

Status verified October 18, 2026. The Next.js dashboard and API run on Blaxel;
the MCP proxy targets Manufact. Local server settings belong in the ignored
`apps/web/.env.local`; hosted settings belong in private `apps/web/.env.blaxel`.
Never paste credentials into chat, use `NEXT_PUBLIC_` for secrets, or copy native
CLI OAuth tokens into a deployment.

The database, private storage, recovery scheduler, Primitive request/result
transport, local transcription, real vision/search and both paid video flows are
verified on r6. Current r7 has database health OK and no missing provider
settings; its only change is job-status URL wrapping for narrow viewports. R6
settings/MCP/source-evidence proof passed **15/15 runtime checks**.
The answer identifies a timeout saved as 60 returning to 30 after reload; cited
frames at 40 and 46 seconds were downloaded and visually confirmed, and the
40–48-second H.264 clip passed checksum and full ffmpeg decode verification.
The talk video's distinct evidence covers 22–31.44 seconds. Private proof:
`.blaxel/paid-settings-proof.json`.

The settings job verified one test PaymentIntent, attempt, entitlement and index;
the same quote returns its receipt, and replay leaves payment/usage unchanged.
Public Link wallets still require a real profile. R6 Manufact transport, nine
tools, caller-owned video read and bundled view assets passed. Backend 65 tests,
worker 39 with real ASR/ffmpeg, web 11 and setup 17 passed. Both migrations also
passed 42 SQL invariants on fresh PostgreSQL; `0002_worker_launch_events.sql` is
applied to the live project. R6 recovery passed all 12 checks, including fresh
signature/replay/tamper handling, 300-second retention and 71 seconds of actual
cron with zero idle HTTP. Earlier browser checks covered desktop, mobile,
keyboard navigation and the test-mode badge. Fresh r7 browser checks passed at
375px and 1280px across both payment tabs without browser patches, including
command/memory disclosures and keyboard navigation. All 40 assets returned 200
with no browser errors. Owned r7 Stripe/Primitive callbacks are enabled and their
signature, persistence and deduplication checks passed. The same-server r7 MCP
deployment is active; read-only job/pack checks preserved correct evidence and
usage. All 12 fresh recovery checks passed, including 70.493 seconds with two
successful cron runs and zero idle HTTP.

## Stripe merchant: verified internal SDK test path

The persistent test key belongs to the **MediaPack sandbox**
`acct_1URr6iKClzw2NVcM`, under parent **Aubric**
`acct_1ULQwVGYTxUe7Sm7`. Its business-profile endpoint still returns 404, but the
SDK sandbox test path can use this explicit configuration:

```dotenv
PAYMENTS_MODE=test
STRIPE_TEST_NETWORK_ID=internal
```

This setting is accepted only in test mode. It creates no fake profile, is never
an automatic fallback, and does not weaken live-mode requirements. A real
`profile_test_…` is preferred when present. An actual isolated protocol smoke
completed **402 → mppx credential → 200 receipt**, then retrieved a succeeded
USD 0.50 Stripe test PaymentIntent (`amount=50`, `livemode=false`) in this exact
sandbox. Private proof:
`/tmp/mediapack-stripe-internal-roundtrip-state.json`. This is a provider-backed
payment proof. The earlier r5 app subsequently completed an actual CLI
settings-video purchase for USD 0.50 in test mode. The talk-video full flow has
passed. R6 settings search/MCP/evidence verification subsequently passed all
15 runtime checks, with one test payment and unchanged usage on replay.

Keep the verified persistent test key in `STRIPE_SECRET_KEY`. A separate sandbox
CLI login is unnecessary; the parent's live CLI context is infrastructure-only.
Run from the repository root:

```sh
node scripts/setup-stripe.mjs --plan
node scripts/setup-stripe.mjs --apply
```

[The helper](../scripts/setup-stripe.mjs) verifies the sandbox identity and either
a real test profile or the explicit internal test path, then manages only its
owned test webhook for `payment_intent.succeeded`. The real plan passed with
`payment_identity=sandbox_internal` and `test_profile_verified=false`; all 25
helper tests passed. Setup makes no payment and reads the current preview origin
from `.blaxel/web-host.json`. Restart after settings change and verify the new
release's webhook and purchase flow. The owned test webhook is now created with
its secret applied: a signed ignored fixture and duplicate both returned 200;
a tampered signature returned 400. Local `stripe listen` has its own secret.

For public Link wallet use, create a real profile at
[Stripe profiles](https://dashboard.stripe.com/profiles) while viewing the
MediaPack sandbox: **Get started**, then its display name and handle. Internal
SDK test-network support does not establish public-wallet readiness.

## Supabase: use the existing direct Free project

The user chose direct Supabase Free in the existing selected account. **Do not
provision through Stripe Projects, create a second project, or upgrade the plan.**
Project `hwijihrfpoufkucxuwis` is ACTIVE_HEALTHY in `us-west-2`. Verification
confirmed checksummed migrations (including applied
`0002_worker_launch_events.sql`), **12 RLS application tables**, the private
`mediapack-private` bucket, and the global **50 MiB (52,428,800-byte)** upload limit.
The deployed Next.js `/health` reports database OK.

The private server configuration has `DATABASE_URL`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `STORAGE_BUCKET`, and the trusted Supabase CA in
`DATABASE_CA_CERT_BASE64`. Keep certificate verification enabled; do not replace
the CA configuration with an insecure TLS bypass. Preserve the independent
`CAPABILITY_PEPPER`, `WORKER_TOKEN_SECRET`, and `INTERNAL_TICK_TOKEN` across restarts.

To inspect or apply a future migration, use the existing helper:

```sh
node scripts/setup-supabase.mjs --plan
node scripts/setup-supabase.mjs --apply
```

[Setup](../scripts/setup-supabase.mjs) tracks migration checksums and applies new
migrations atomically. It refuses an untracked existing application schema and
requires an exact private 50 MiB bucket. Database health alone does not prove a
complete upload, payment or worker result: verify bootstrap/cookies, authenticated
listing and a real signed upload against the deployed app.

## Buyer credentials are separate from merchant credentials

The default buyer uses mppx shared-payment tokens in Stripe test mode. Configure
`MPPX_STRIPE_SECRET_KEY=sk_test_…` only in the buyer environment and use test
payment method `pm_card_visa`. To match the explicit internal merchant test path,
also set `MPPX_STRIPE_TEST_NETWORK_ID=internal`; the CLI supports
`buy <job> --via mppx`. Never pass buyer credentials to a worker.

The real provider rejects optional `seller_details` with HTTP 400
`parameter_unknown`. The buyer permits exactly one SDK-safe retry omitting those
optional fields for that exact response. It does not retry this way on a timeout
or any other status/error. Six buyer tests passed.

Link remains optional and uses its own account/approval flow. Public Link wallet
use still requires a real merchant profile; no live Link wallet purchase is
claimed.

## Primitive: enabled with a real delivery smoke

The persistent Primitive server key is valid. Setup was applied and the web host
restarted with its private settings. The existing managed domain is verified;
the app-owned org-wide webhook is **enabled**. Actual MediaPack work requests
and results traveled through Primitive and 4 GB Blaxel workers: both the settings
and talk videos reached ready with actual metadata and source digests. Private
proof is retained in `.blaxel/public-pair-proof.json`. This proves the upload,
probe and request/result path. The talk-video paid indexing/search/evidence
flow has also passed. Final r6 settings search/MCP/evidence verification passed
15/15 checks with real requests/results and current 4 GB workers.

```sh
node scripts/setup-primitive.mjs --plan
node scripts/setup-primitive.mjs --apply
```

[Setup](../scripts/setup-primitive.mjs) reuses the existing account-scoped signing
secret and valid control/worker addresses. It prepares only the owned disabled
endpoint, preserves a dedicated worker key when present, and handles an origin
change through its private ownership record. Do not rotate the organization
secret or substitute the one-hour CLI OAuth access token for a server key.
Current API permissions allow managed-zone recipients; older opt-in notes are
superseded. Setup prepares a disabled endpoint when it creates one; the current
owned endpoint was separately enabled and real work-envelope/result processing
has passed. Recheck callback routing when a new preview origin is deployed.

## Blaxel hosting and runtime authentication

Reuse the credited `mediapack` workspace. Applications private-preview access is
unavailable, so Next.js uses a **sandbox public preview**. The web sandbox has
2048 MB and permits automatic standby with `keepAlive=false`. Current r7 uses
`ttl-idle: 24h` through judging; the deployed policy was read back and verified.
The helper defaults to 1h and accepts whole-hour values from 1h through 24h.
Workers retain 4096 MB, bounded execution and a 30-minute sandbox lifetime.
A real service-account cleanup smoke deleted four eligible completed worker
sandboxes and preserved the web host. The bounded cleanup runs before new
launches and verifies ownership/image/completed processes; standby by itself is
never sufficient. Private evidence: `.blaxel/worker-reaper-proof.json`. See
[the cost guide](blaxel-costs.md) and [worker configuration](../worker/README.md).

Native `bl login mediapack` works for local operations. Hosted worker launch and
model access support server-only `BL_CLIENT_CREDENTIALS` with `BL_WORKSPACE`;
explicit `BL_API_KEY` is also supported. Following the user's explicit approval,
the workspace-scoped member service account `mediapack-runtime` was created.
Credentials are stored in an ignored mode-0600 file. SDK client-credentials
authentication and model discovery returned 200. Actual worker probe orchestration
and real vision/search passed. Current r7 image
`sandbox/mediapack-web:b355ba20b80085378c07c` is deployed at
[the r7 app](https://b45bc8809f4a40e5dad83cb402719f89.preview.bl.run/app), with
database health OK and no missing provider settings. Primitive is enabled with
signature persistence and deduplication verified. The talk-video full flow
passed, and source-specific settings search/MCP/evidence verification passed
15/15 runtime checks. Normal deployed frame retrieval also reclaimed a completed
current-image search worker. Do not copy local CLI tokens or rely on the custom sandbox's identity
file. An infrastructure `BL_API_KEY` cannot be forwarded as a model API
key: workers must receive a short-lived client-credentials OAuth token or a
dedicated model key. The launcher guards credential discovery and shares one
SDK initialization across concurrent launches so one operation cannot reset
another operation's credential object.

Use an immutable built web image with [the hosting helper](../scripts/host-blaxel.mjs):

```sh
node scripts/host-blaxel.mjs --image sandbox/mediapack-web:BUILT_IMMUTABLE_TAG --env-file apps/web/.env.blaxel --idle-ttl 24h
```

The shown 24h policy preserves the judging demo; omit `--idle-ttl` to use the
1h default for ordinary short sessions. Add `--restart` after changing server settings. The helper assigns the preview
origin, updates private host state and verifies the deletion policy. Never set a
positive execution timeout on the long-running web process: the current
sandbox-api kills it when elapsed, even without process keep-alive. Readiness is
checked separately.

Standby stops active compute billing; retained snapshots/images can still cost
money. `ttl-idle` counts resume/suspend events, so a continuously active session
can also be deleted after the configured interval. With 1h this could interrupt
an active demo; the current release uses 24h for that reason. Deletion removes
the host and preview; rerun
hosting and refresh owned callback, recovery and Manufact origins if changed.
This policy is not an account spending cap.

## Models: existing gateway plus local transcription

Use the existing Blaxel gateway
`https://run.blaxel.ai/mediapack/models/sandbox-openai/v1` for vision/search, with
`OPENAI_VISION_MODEL=gpt-4o-mini` and `OPENAI_SEARCH_MODEL=gpt-4o-mini`.
`OPENAI_API_KEY` is optional with supported Blaxel authentication; a new direct
OpenAI key or paid audio API is not required. Configure `OPENAI_BASE_URL` with
that gateway with the validated runtime authentication above. Real vision and
search in the latest 4 GB worker are proven in
`.blaxel/model-runtime-proof.json`; no persistent infrastructure API key is passed
to the worker as a model credential.

The immutable worker image
`sandbox/mediapack-worker:be53b19cc608a18554956` bundles **whisper.cpp 1.9.5** and
the pinned multilingual base weights. An earlier real 4 GB cloud smoke transcribed
**44.864 seconds of audio in 7.618 seconds**, returning nine segments. This is
one measured sample, not a general latency promise or proof of the full indexing
flow. Production audio uses the local engine without an audio API fallback.

## Durable recovery without waking an idle host

Supabase minute recovery is installed. Its SQL predicate sends HTTP only when
persisted work is due; an idle workload emits no HTTP. The hosted HMAC/nonce path
returned 200 for a fresh request and 401 for replay. Nonces are retained for
300 seconds. A real committed operation
whose immediate dispatch was deliberately missed recovered through cron in
**34.585 seconds**; the next idle cron run queued zero HTTP. All 13 checks passed.
Private proof: `.blaxel/recovery-interruption-proof.json`.

```sh
node scripts/setup-recovery.mjs --plan
node scripts/setup-recovery.mjs --apply
```

[The recovery guide](recovery-scheduler.md) explains the due-work rules, Vault,
authentication, ownership and checks. After recreating an expired host, rerun
hosting first, then recovery plan/apply to update its owned origin. Cron cannot
recreate a deleted Blaxel sandbox. R6 scheduler-origin reapply succeeded with
Vault target and active schedule verified. Fresh signed tick returned 200,
replay/tamper returned 401, and 300-second retention was read back. A final
71-second actual cron observation returned zero idle HTTP, completing all 12 r6
checks. R7 origin reapply and all 12 fresh recovery checks also passed: signed
tick 200, replay/tamper 401, retention 300 seconds, and 70.493 seconds spanning
two successful cron runs with zero idle HTTP.

## Manufact: transport and owned-video access verified

Existing organization authentication is confirmed. R6 health, MCP transport,
all nine tools, caller-owned video read and bundled view assets passed at
`https://fast-wave-awovc.run.mcp-use.com/mcp`. Final settings search returned the
source-specific saved-60/reloaded-30 answer with cited frames and a playable clip;
downloaded evidence passed visual, checksum and decode checks. The final runtime
proof passed 15/15 checks; both talk and settings flows are complete. A new
same-server r7 deployment `4c0f3b54` is active with only `MEDIAPACK_API_URL`
pointing at r7. Read-only `get_job` and `get_pack` preserved the correct search,
four frame references and two clip references without creating operations or
changing usage. Discovery listed all nine tools and bundled view assets returned 200.

Follow [the MCP guide](../apps/mcp/README.md). Give the proxy only
`MEDIAPACK_API_URL` pointing at the current Blaxel HTTPS origin; never copy
database, payment, model or Primitive credentials into it. After readiness,
verify `/healthz`, the `/mcp` transport, caller capability forwarding and the
bundled job view. Set optional `MCP_PUBLIC_URL` on Next.js to the verified
Manufact MCP endpoint. Refresh the API origin when a Blaxel preview is recreated.
