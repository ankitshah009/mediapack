# MediaPack release checks

This runbook describes how to release the complete project and prove its critical path. The [verification record](verification.md) contains dated evidence; it is not proof that every provider is currently connected.

The October 18 cloud record includes Supabase Free, real signed uploads, Primitive worker delivery, two idempotent test purchases, source-specific search and verified frames/playable clips for both recordings, a running Manufact proxy, automatic completed-worker reclamation and conditional recovery with zero idle HTTP requests. The final r7 release adds the unpaid job page's mobile text-wrapping correction; consult the newest verification section for exact images, rollout checks and historical provenance.

## Documentation map

| Document | Use |
| --- | --- |
| [Root README](../README.md) | Install, run, CLI workflow and Blaxel deployment |
| [Build decisions](../DECISIONS.md) | Implemented architecture and choices that supersede earlier plans |
| [Wire contract](../CONTRACTS.md) | Ownership, operations, payment and allowance behavior |
| [Account setup](SETUP-ACCOUNTS.md) | Provider provisioning and private configuration |
| [Verification record](verification.md) | Actual checks and remaining provider evidence |
| [Blaxel costs](blaxel-costs.md) | Dated rates, budget assumptions and expiration semantics |
| [Next.js app](../apps/web/README.md) | Dashboard/API setup and routes |
| [Manufact MCP proxy](../apps/mcp/README.md) | MCP configuration, deployment and runtime checks |
| [Shared backend](../apps/mediapack/README.md) | Service boundaries and integration tests |
| [Media worker](../worker/README.md) | Worker runtime, configuration and media tests |

## Publish the complete source

Local source-publication checks on October 18, 2026 (UTC) passed: 25 backend tests, 30 worker tests, 27 setup-helper tests including actual disposable Postgres, 10 web tests and 10 MCP tests; all 42 SQL invariants; web lint and production build; MCP typecheck, production build and a fresh CLI runtime smoke. A freshly started standalone Next.js server served the dashboard, pairing page and all 12 referenced browser assets, with expected actionable 401 and unconfigured-database 503 responses. The Blaxel packaging preflight also passed. The web build retained the previously recorded third-party Tempo dynamic-import warning. These checks made no live provider purchase and do not establish a configured cloud database or full paid video workflow.

The subsequent Free-plan update passed 26 backend, 30 worker, 15 Supabase setup, 11 web and 11 MCP tests, plus web lint/build, MCP typecheck/build/runtime smoke and the packaging preflight. A fresh standalone Next.js server with disposable Postgres proved browser session creation, the exact 50 MiB HTTP reservation boundary, safe retry and owner isolation. Storage was a local provider-edge fixture. See the verification record for the authorization blocker and the limits of this runtime evidence.

The project includes `apps/web`, `apps/mediapack`, `apps/mcp`, `worker`, `supabase`, `scripts`, fixtures and documentation. Next.js imports the shared backend by relative path, so publishing the dashboard alone is incomplete.

Before committing, verify that the Git root contains all these directories and the intended remote is configured. Keep credentials and generated artifacts excluded: `.env*` except examples, `.projects/vault`, `.projects/cache`, `.blaxel`, `.aws`, private CLI state, dependencies and build output. Preserve the fixture recordings needed by media tests; source repositories and image builds have different input requirements.

Commit only the reviewed snapshot. Run the relevant checks against it, inspect the staged diff, and use a normal fast-forward push from `main`. Record the resulting commit and repository URL. A source push does not imply a cloud deployment or an operational provider integration.

## Local verification

Run from the repository root unless a command selects a package:

```sh
node --test scripts/setup-primitive.test.mjs scripts/setup-supabase.test.mjs
bash scripts/test-db.sh
npm --prefix apps/mediapack test
npm --prefix worker test
pnpm --dir apps/web test
pnpm --dir apps/web lint
pnpm --dir apps/web build
npm --prefix apps/mcp run typecheck
npm --prefix apps/mcp test
MEDIAPACK_API_URL=http://127.0.0.1:3000 npm --prefix apps/mcp run build
npm --prefix apps/mcp run test:runtime
node scripts/deploy-blaxel.mjs
```

Database and transport integration tests need local Postgres, ffmpeg and permission to bind loopback sockets. Enable the setup helper's optional real-Postgres test with `MEDIAPACK_TEST_POSTGRES_BIN` pointing to the installed Postgres binary directory. The MCP build validates its API origin; the loopback URL above is suitable for a local build, and deployment must use the actual hosted API origin. Local tests do not perform provider purchases. Never run `supabase/tests/invariants.sql` on the app database: it writes synthetic state and belongs in the disposable cluster only.

## Provider and configuration gates

| Gate | Required evidence |
| --- | --- |
| Database | Migrations applied; deployed `/health` reports `database: "ok"` |
| Browser session | Bootstrap succeeds; browser gets a Secure, HttpOnly cookie and loads its video list |
| Storage | Private bucket and object limit verified; a real video reaches Storage through its signed upload instructions |
| Primitive | Persistent credentials; signed event persistence; enabled app-owned endpoint; actual work request and result delivery |
| Blaxel | Correct images and allocations; ready logs; supported runtime launch authentication; bounded workers |
| Models | Actual vision, transcription and search calls, or a verified packaged local engine |
| Stripe sandbox | Verified test account, profile or explicit internal test-network configuration, and owned webhook; one purchase unlocks exactly one entitlement. Public Link wallets require an actual profile. |
| Manufact | Public MCP endpoint forwards caller-specific capabilities to the current API origin |
| Recovery | Deployed scheduler invokes the authenticated tick and recovers an interrupted operation |

Configuration presence is only a prerequisite. `/health` can return 200 while its database field says `unconfigured`. A valid signature on an ignored Primitive payload proves signature checking, not persistence or worker delivery.

The user selected Supabase Free. The current upload contract and private bucket use 50 MiB (52,428,800 bytes). Verify Storage's global file limit as well as the bucket limit before calling uploads operational. See account setup for the current authorization status. Blaxel credits do not establish a balance with another provider.

## Deploy and prove the runtime

Follow the root README's image-build and hosting instructions. Apply private server configuration at runtime and restart the correct web process after environment changes. Use a fresh sandbox name for a new image; changing image metadata did not replace the filesystem in the recorded rollout.

Read ready logs, load `/app` and its browser assets, and verify browser sessions and real signed upload. Configure Primitive and Manufact with the resulting API origin. Sandbox previews disappear when deletion fires; update callbacks when an origin changes. The web host uses 2 GB and permits standby. The helper defaults to one-hour deletion; the current judging deployment uses `--idle-ttl 24h`. Workers request 4 GB and have a 30-minute maximum sandbox lifetime. These policies are not a dollar cap.

For the full demonstration:

1. Upload a new source and wait for actual validation, including its digest and media metadata.
2. Complete one explicitly authorized Stripe test purchase. Retry the same quote and prove it does not charge again.
3. Observe persisted work delivery, a real Blaxel worker, its result and completed indexing.
4. Ask a source-specific question. Retrieve cited frames and a playable clip; verify allowance and timestamps.
5. Repeat with a different video. Check that results change and another owner cannot access the first owner's state.
6. Preserve redacted job, operation, payment, message and artifact references with the tested commit, image tags, runtime versions and time.

Keep capabilities, cookies, signing secrets, payment tokens, signed URLs and raw personal data out of the evidence record. Describe observed evidence without claiming hidden causes. Keep Stripe test mode visible throughout.
