# Verification status

This file distinguishes exercised local behavior from credentialed provider verification. It is not a successful deployment or purchase receipt.

## Application and protocol checks (2026-10-17)

Executed with Node 26.11.1, Next.js 16.4.2, mcp-use 2.10.1, local Postgres 17, and local ffmpeg/ffprobe:

| Check | Result |
| --- | --- |
| Next.js production build | Pass, webpack, TypeScript, prerendering and standalone tracing; approximately 61 MiB standalone runtime |
| Next.js ESLint | Pass, no errors or warnings |
| Viewer/API and event reducer tests | 10 passed |
| SQL transaction invariants | 42 passed in a disposable local cluster |
| Backend integration, SDK protocol, configuration and launcher tests | 25 passed |
| Media worker tests | 30 passed, including actual decoded frames/clips, variable-frame-rate input and a nonzero source start |
| Manufact MCP tests | 10 passed, plus production build and fresh built CLI listener smoke |

The backend tests use real Hono requests through the same in-process router mounted by Next.js, actual Postgres transactions, official webhook signature verification and actual mppx/Stripe protocol handling. External provider I/O is replaced at the network/adapter boundary; no Stripe payment or cloud resource was created. Worker model tests replace provider HTTP, while ffmpeg executes against real local recordings.

The built standalone Next.js server was started from a fresh process on `127.0.0.1:3333`. HTTP checks passed for health, dashboard, pairing and dynamic job pages, every referenced browser script, unauthorized API responses, JSON 404s, browser-origin rejection and internal-token rejection. The final API errors include `error`, `hint` and `next_action`. `/llms.txt` identifies the separate Manufact MCP host.

Browser QA through gstack passed dashboard rendering, native Next.js navigation to the pairing form, disabled empty-code submission and a 390×844 phone viewport with no horizontal overflow. The only observed browser console error was the expected unauthenticated `/v1/videos` 401. The production browser bundle excludes fixture replay. No paid/indexed provider state was fabricated for this check.

The Next build reports a third-party dynamic-import warning from an unused mppx Tempo dependency. The configured Stripe SPT path passes its protocol tests. Image builds and hosted provider verification remain separate gates below.

## CLI and operator tooling

Completed in the implementation environment:

- `node --check scripts/mediapack.mjs` and `node --check scripts/tick.mjs`.
- CLI help/version and tick help.
- A temporary local HTTP fixture exercised real CLI subprocesses: bootstrap, private `0600` state, duplicate-bootstrap protection, streaming upload and completion, video listing/status, quote, job status, stdin search and operation polling, frames, clip, events, pack, artifact download/SHA-256, pairing, health and authenticated recovery tick.
- The fixture verified that owner capabilities were absent from stdout/stderr and storage requests, output files were not overwritten, insecure state-file permissions were rejected, and invalid clip ranges failed.
- Paid and reconciling fixture jobs caused no purchase request. A mismatched Stripe sandbox challenge was rejected before any Stripe token request. The saved uncertain-attempt marker blocked a second buyer attempt.

The fixture used local transport bytes, not a decodable source video. It does not prove media processing or an external payment. No real purchase was executed by these checks.

## Containers and hosting

Local worker image builds failed with `ENOSPC` in Colima; no cleanup/pruning was performed. The final worker image was subsequently built successfully using the real Blaxel remote builder in workspace `mediapack`.

Published image: `sandbox/mediapack-worker`, immutable tag `b8d334961f500bb287aa8`, status `BUILT`, completed 2026-10-17 23:07 UTC. A temporary sandbox from the image ran a real SDK process with exit code zero: Node 22.23.3, ffmpeg 8.1.2 and ffprobe 8.1.2. The sandbox API's process/log interfaces worked. The temporary smoke sandbox was removed after verification. This proves image build and runtime boot, not a paid Primitive/model processing job.

The real Next.js Application deployment was attempted in the authenticated workspace and rejected before build with `Applications feature is not enabled for this workspace`. Authenticated `GET /features` returned only `build-sandbox: true`. The inspected SDK offers feature reads, the CLI has no feature-enable command, and the hosted MCP metadata exposes no enable/request-access tool. Applications is documented as private preview. No supported self-service enablement path was found; Blaxel-side access appears necessary. The user subsequently chose to retain Blaxel hosting and requested idle cost protection, so the web host now uses a sandbox public preview.

Actual Next.js sandbox hosting succeeded on 2026-10-17 UTC: remote-built image `sandbox/mediapack-web:bbaf352d30cc5ee472aef`, sandbox `mediapack-web`, public origin `https://aff3262cd342ccc92bcdc19de143d861.preview.bl.run`. The compiled Next.js server reported ready, public health returned 200, `/app` and `/app/pair` returned 200, all eight browser script assets returned 200, `/llms.txt` used the correct public origin, and `/v1/videos` returned the expected actionable 401. Web tests (10) and lint passed during hosting changes. Runtime secrets were excluded from source/image builds and passed privately to the process.

Cost protection was applied to the actual sandbox and read back: `lifecycle.expirationPolicies = [{type: "ttl-idle", value: "1h", action: "delete"}]`. The old keep-alive process was killed, then the compiled server was restarted successfully with `keepAlive: false`; process status confirmed running/keepAlive false, ready logs were checked without printing them, and public health remained 200. The minimal API sandbox configuration worked; optional fields from the initial shorthand configuration were rejected, and the hosting script now uses the verified minimal model.

The initial no-keep-alive restart with timeout 30 later became killed/exit -1 and the preview timed out. Although generated SDK comments and the process documentation describe startup-only timeouts without keep-alive, the current [sandbox-api timeout implementation](https://github.com/blaxel-ai/sandbox/blob/main/sandbox-api/src/handler/process/timeout.go) arms SIGKILL for any explicit positive timeout. The corrected launch omits both timeout and `waitForPorts`, checks readiness separately, and uses a fresh process name for clear attribution. Two consecutive 12-second idle intervals (no SDK calls) followed by public health/pairing requests returned 200 in 214/227 ms. A subsequent 32-second idle interval returned health 200 in 299 ms, beyond the old execution timeout. The browser then loaded `/app` with 200 and rendered the Videos/Pair links and upload controls. This demonstrates responding after idle intervals; internal suspension state was not directly measured. The hosting CLI also has a 120-second client watchdog and does not automatically retry uncertain mutations.

Expiration is deletion, not standby. Blaxel's idle-policy clock counts resume/suspend transitions, so a continuously active session can also be deleted after one hour. Deletion removes the preview; rerun `scripts/host-blaxel.mjs` and update external callbacks if the URL changes. Automatic standby avoids active compute billing, but snapshots and retained images have storage charges. This is not a workspace spending cap. The policy itself was verified by readback; one-hour deletion was not waited out.

The deployed health response explicitly reports the database/storage/Stripe/Primitive integrations unconfigured. Supabase, Stripe, Primitive and OpenAI server settings are still missing, and the Manufact proxy has not been deployed. This is a verified public Next.js host, not a successful end-to-end media processing release.

The confirmed credited remote Blaxel build path bypasses the local Docker disk constraint. Use `scripts/deploy-blaxel.mjs` for local preflight, then the README's remote image-push and `scripts/host-blaxel.mjs` commands. Public Next.js boot and worker runtime checks succeeded as recorded above. Local Docker cleanup is optional and was not performed.

`link-cli` was absent; Link flags are probed dynamically before use. Official Blaxel CLI v0.1.127 was installed, checksum-verified, only in `/tmp/mediapack-blaxel-bin`; setup, skills, shell PATH changes and completions were disabled. Its actual help confirms remote deployment builds, `--wait`, `--recursive=false`, application resource type and sandbox image push. The user confirmed existing credits and subsequently completed native CLI login to workspace `mediapack`; no additional plan or API-key-only authentication is required.

Initial local dry-runs verified an Application resource; current configuration and preflight verify the web Sandbox with port 3000/memory 2048 and a separate Sandbox worker resource. `scripts/deploy-blaxel.mjs` validates both packaged source lists and prints summaries without resolved environment values. Both archives excluded credential/tooling state, dependencies, caches, documents and media; the worker directory produced a 32-entry archive with its own root package/build files. The current web source archive has 308 entries (this changes with source edits).

Two actual CLI behaviors were verified: application `memory`, `region` and `port` must be top-level config fields in v0.1.127, and absolute `--env-file` silently omitted an innocuous marker variable. The sandbox hosting script parses the env file directly, avoiding that CLI issue. Worker push must run from `worker/`; `--directory worker` from the repository root packages the root context. Application Runtime remains unavailable; the hosted Manufact/Primitive/model/Stripe sandbox flow still requires recorded provider smoke results.

## 4 GB worker rollout (2026-10-17 Pacific)

The actual control-service `workerLaunchSpec` now requests 4096 MiB, matching `worker/blaxel.toml`; the Next.js host remains 2048 MiB. All five launcher/configuration tests passed, including an assertion on the SDK sandbox-create boundary. A fresh remote Next.js image build succeeded: `sandbox/mediapack-web:b490b2d541473adab3a7a`.

Updating the old sandbox's image metadata did not replace its existing compiled filesystem: runtime bundle inspection still found the 2048 MiB launcher. A fresh sandbox, `mediapack-web-r2`, was therefore created from the new immutable image. Inspection of its deployed Next.js server bundle confirmed the 4096 MiB worker allocation. Its process reported ready with `keepAlive: false` and the existing one-hour idle deletion policy. The old `mediapack-web` sandbox was deleted after replacement checks passed.

Current public origin: `https://1257b398063e17056e15c122a73a422c.preview.bl.run`. After a 32-second interval without sandbox SDK traffic, `/health` and `/app` returned 200, all eight referenced JavaScript assets loaded successfully, and a correctly signed empty ignored Primitive webhook returned 200. These checks completed in 873 ms after the idle interval. The application-owned Primitive endpoint was rotated to the new origin and remains disabled. No mail was sent. Database configuration is still absent.

A separate temporary sandbox booted the existing worker image `sandbox/mediapack-worker:b8d334961f500bb287aa8` with a read-back allocation of 4096 MiB. A real process exited zero and reported Node 22.23.3 and ffmpeg 8.1.2. The temporary worker was deleted in cleanup. This proves the requested cloud allocation and worker boot; it does not measure CPU/RAM quotas from inside the guest or prove a full processing job. Local Whisper remains uninstalled; the resource change alone does not enable transcription.

The [cost review](blaxel-costs.md) records today's verified public rates, $500 scenarios and timestamped workspace usage. The reported usage is not an available-credit balance.

## Release evidence still required

### Supabase through Stripe Projects

Stripe CLI 1.54.0 was installed through Homebrew and its official Projects plugin 0.50.0 was installed successfully. Installed help was inspected for `init`, `catalog`, `add`, `env` and `link`. The plugin's local subprocess handshake required execution outside the restricted process sandbox. A live unauthenticated `catalog supabase --json --interactive=false` request succeeded, listing Free ($0), Pro ($25/month), Team and the project deployable. A read-only init preflight returned `BROWSER_AUTH_REQUIRED`; native Stripe device login was started and is awaiting user completion. No project, provider resource, payment method or paid subscription was created.

The current 100 MiB upload contract exceeds Supabase Free's documented global maximum of 50 MB. The user was asked to choose Free with a coordinated 50 MB application limit or Pro starting at $25/month. No limit or billing change was made while that choice was pending. Blaxel credits do not establish a Supabase billing allowance.

`scripts/setup-supabase.mjs` now provides a read-only plan and an explicit apply step for an already-provisioned project. It applies ordered migrations in atomic transactions, tracks filename/SHA256, locks concurrent setup, refuses untracked or inconsistent app objects, and configures/read-checks the private bucket. It explicitly reports the project-wide upload cap unverified. Fifteen tests passed, including a fresh local PostgreSQL 17 process with boot logs checked, all 12 actual migration tables and RLS, idempotent reapplication, and rollback of both failed DDL and its checksum record. That scratch cluster was stopped and removed. Storage network I/O was replaced at its adapter boundary; no actual Supabase credential or storage endpoint has been exercised.

Stripe Projects' `.projects` vault and generated skills are excluded from Blaxel source archives and Docker context; the preflight rejects their inclusion. The local archive/configuration preflight passed. The existing deployed app has not been restarted with Supabase settings because account provisioning remains pending.

### Primitive account connection

Native CLI browser login succeeded in the existing account. Authenticated account/domain/endpoint/signing-secret/send-permission reads returned 200, with one verified active managed domain and no endpoints before setup. The setup helper now saves only the existing account signing secret and service addresses privately (env mode 0600), and records ownership of one disabled org-wide HTTP endpoint. CLI OAuth access/refresh tokens are not copied into the app. The first endpoint request was rejected with HTTP 400 because a pull-only `name` was included; removing it produced a successful create. A subsequent plan found the saved endpoint and proposed reuse rather than creating a duplicate. All 12 setup tests pass, including ownership, idempotency, URL rotation, unrelated-route preservation, OAuth token exclusion, private env preservation and safe errors.

The web process was restarted with those settings while retaining `keepAlive: false` and one-hour idle deletion. A correctly signed **empty ignored** webhook payload returned 200; a tampered signature returned 401. Health reports `primitive_webhook: true`, but `primitive: false` and database unconfigured. This proves public receiver configuration and signature validation only. No mail or provider test delivery was sent, and event persistence/work request/reply remains unverified. A persistent runtime Primitive API key is still absent. The endpoint remains disabled pending credentials and a working database.

### Blaxel model gateway

The existing `sandbox-openai` model gateway is deployed/enabled with configured model `gpt-4o-mini`. Empty POST validation (no inference) returned provider input-validation 400 responses on Responses/chat, while audio transcription returned 403 endpoint-not-allowed. Local native CLI authentication works; the custom sandbox has no injected OpenAI/Blaxel API credentials, and its mounted identity token returned 401 for ordinary model/API use. This is evidence for an available gateway route, not a completed worker integration or successful model processing. Current worker source still uses the direct OpenAI adapter. See the integration notes for precise limitations.

Record the actual Next.js build/runtime checks, database/worker test results, and provider smoke results with versions and times. For the credentialed end-to-end run, preserve redacted video/job/payment/operation/Primitive-message/artifact IDs. Demonstrate a new video's source digest, grounded arbitrary search, source frames and playable clip; repeat with a different video and verify ownership and retry behavior. Publish no owner capabilities, SPTs, signed URLs or account secrets in the run manifest.
