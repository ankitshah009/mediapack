# Verification status

This file distinguishes actual provider verification from local fixtures. The newest cloud record comes first; older sections retain the historical results and account blockers that existed at their recorded dates.

## Browser demo-agent payment, r12 (2026-10-18 UTC)

Deployed Next.js image `sandbox/mediapack-web:b42acfca444b6cf333f55` to `mediapack-web-r12`, preserving `https://mediapack-mediapack.preview.bl.run`. Ready logs, database health, all provider settings, `keepAlive: false` and the 24-hour idle-delete policy were verified. Applied checksummed migration `0003_demo_buyer.sql` to the existing Supabase Free project; the private 50 MiB bucket was reused.

An explicitly opted-in run of `RUN_DEMO_PAY=1 MEDIAPACK_URL=https://mediapack-mediapack.preview.bl.run node demo-video/capture/e2e-live.mjs --demo-only` used a fresh browser owner and the actual **Pay $0.50 with demo agent (test mode)** button. The complete check passed in **75.907 seconds**:

| Step | Observed time |
| --- | --- |
| Fresh upload and browser session | 2.282 s |
| Server media verification | 4.182 s |
| Quote | 0.811 s |
| Browser demo-agent payment | 2.216 s |
| Indexing to ready | 25.618 s |
| Cited search | 12.521 s |
| Two source frames | 12.826 s |
| Source clip | 8.382 s |

The answer stated that the timeout was saved as **60 seconds** and reverted to **30 seconds after reload**, with a supported 34–48 s citation. The exported 42 s and 47 s frames visibly show 60 and 30 respectively. Both loaded at 1280×800. The eight-second H.264 clip covers 40–48 s, loaded and decoded in the browser, and passed a complete ffmpeg decode. All three downloads matched the recorded SHA-256, source hash, MIME type and requested timestamps.

Repeating the same quote's demo-purchase request preserved the PaymentIntent, allowance and operation count. Reload preserved the paid job and single index. The desktop document fit 1280 px and the mobile document fit 375 px. No page errors occurred; no owner capability or Stripe secret was exposed to browser JSON or storage, and the session cookie remained HttpOnly.

Independent provider and SQL verification passed **12/12** checks: one succeeded payment attempt, one succeeded USD 0.50 **test** PaymentIntent, matching job/quote/terms/attempt metadata, one succeeded demo reservation, one verified-payment event, one successful index with a real Blaxel sandbox, a sent Primitive index request, and a 24-hour entitlement. Manufact health, MCP initialization, all nine tools and a caller-owned persisted `get_job` read also passed without spending allowance.

Local validation passed **99 backend tests**, **30 web tests**, **6 CLI buyer tests**, **17 setup tests**, **42 existing SQL invariants** and **8 new database tests**, plus lint, TypeScript and local/remote Next.js production builds. Database race tests used independent PostgreSQL sessions; provider-edge integration tests used local Stripe HTTP fixtures. The cloud browser proof used the real providers.

Limits are atomic rolling-24-hour reservations, capped at two per browser owner and 100 globally. Failed or uncertain attempts stay consumed across restarts. These cap demo starts and do not guarantee a dollar spending limit. Private evidence is in ignored `.blaxel/demo-buyer-proof.json`, `.blaxel/demo-buyer-ledger-proof.json`, browser state and exported artifacts; credentials and signed URLs are excluded from the public record.

## Live end-to-end browser check, r11 (2026-10-18 UTC)

`demo-video/capture/e2e-live.mjs` drove the public URL from a fresh Chrome profile and passed **26/26** checks:

- **Upload with no session:** a fresh visitor rejected a non-video file client-side. An upload with no session then started one automatically; this was the reported "Missing or invalid credentials" bug, fixed in r10. The video page loaded in 1.4 s.
- **Verification and quote:** ffprobe verification on a Blaxel worker finished in 11.2 s with the real metadata (0:53 · 1280×800). The quote page showed $0.50 with the HTTP 402 buy command and Upload → Verify media → Purchase steps.
- **Pairing:** an invalid code showed an error; a valid one showed the agent's videos.
- **Paid settings job:**
  - the cited 0:40–0:48 answer seeks the source to 40.0 s even when clicked before the signed source URL loads (fixed in r11)
  - 4 frames and 2 clips load
  - the receipt and allowance render
  - 12 steps / 49 events, with the raw toggle working both ways
  - the exhausted pack is explained
  - no `[object Object]` anywhere
- **Real extraction:** one frame on the paid talk pack went Primitive → Blaxel worker → Storage → UI in 6.0 s.
- **Mobile:** at 390 px there was no horizontal scroll, and upload plus verification of the speech video worked.
- **No uncaught page errors.**

The same session also checked the other public surfaces:

| Surface | Result |
| --- | --- |
| `/health` | all integrations true |
| `/llms.txt` | 200 |
| Unauthenticated `/v1/videos` | `{error, hint, next_action}` with `UNAUTHORIZED` |
| Forged Primitive webhook | 401 |
| Forged Stripe webhook | 400 |
| Unauthenticated `/internal/tick` | 401 |
| Manufact MCP | initialize, 9 tools, and `get_job` on the paid job all succeeded; without a capability → `UNAUTHORIZED` tool error |

**Fresh paid run on r11.** A new agent owner ran the CLI (`demo-video/.cache/rehearse.sh`) against the public URL. Every step exited 0:

| Step | Time |
| --- | --- |
| Upload | 1 s |
| Verification | 11 s |
| Quote ($0.50 USD, test) | 0 s |
| HTTP 402 → Stripe test purchase | 8 s |
| Indexing to ready | 27 s |
| Search 1 | 9 s |
| Search 2 | 5 s |

- **Payment:** `paid`, with a test-mode PaymentIntent and a pack expiring 24 h after payment.
- **Search 1** answered "visible request timeout is 30 seconds, different from the saved 60 seconds", citing 0:38–0:48 (supported).
- **Search 2** asked "Does anyone delete the workspace?" and returned "No evidence … found" with no citations.

## Stable origin and dashboard r8/r9 (2026-10-18 UTC)

- **Stable URL.** A second Blaxel preview with `prefixUrl: mediapack` served `https://mediapack-mediapack.preview.bl.run`, and `/health` returned database OK with every integration configured. `scripts/host-blaxel.mjs --stable-prefix mediapack --move-from <old>` then deployed r8 (`sandbox/mediapack-web:bc1db435fcf9f8138bf54`) and then r9 (`sandbox/mediapack-web:b3df59cc77af80222164d`). Each time it checked the new release preview, moved the stable preview, and read back `/health` 200 with database OK, no missing settings, `keepAlive: false` and a 24-hour idle-delete policy.
- **Callbacks moved once.** The owned Stripe test webhook was updated with `setup-stripe --apply --origin <stable>`. The owned Primitive endpoint was rotated with `setup-primitive --apply`, which leaves it disabled; it was then re-enabled with PATCH `{enabled:true}`, and the read-back showed `enabled: true` at `/webhooks/primitive` on the stable origin. The Supabase recovery schedule was re-pointed with `setup-recovery --apply`. Manufact deployment #8 is running with `MEDIAPACK_API_URL` set to the stable origin, and a `get_job` tool call through `https://fast-wave-awovc.run.mcp-use.com/mcp` returned the paid, ready settings job.
- **Dashboard changes.** These were verified in a separate Chrome on the stable origin against the paid settings job. The activity panel shows 12 steps for 49 persisted events (Upload, Verify media, Purchase, Index video, each search with its query, frames, clips), each with a provider stage strip and a duration. Raw events are still available behind a toggle. Clip thumbnails show a first frame. The historical failed launch renders as readable text instead of `[object Object]`, and new launch failures store readable provider text (`launchErrorText`). Checks passed: backend 66 tests, web 15 tests, web lint, typecheck and a production build.
- **Blaxel policy not available.** A daily `maxToken` policy for the `sandbox-openai` gateway was rejected: `Quota exceeded: 1/0 policies`. No plan change was made.
- **Browser-only live upload.** A fresh browser session uploaded `fixtures/settings-reset.mp4` to the stable origin, passed server ffprobe verification and froze a $0.50 test-mode quote. It was not purchased.

## Credentialed cloud verification (2026-10-18 UTC)

The final Next.js r7 release uses `sandbox/mediapack-web:b355ba20b80085378c07c` and worker `sandbox/mediapack-worker:be53b19cc608a18554956` in Blaxel workspace `mediapack`. The [dashboard](https://b45bc8809f4a40e5dad83cb402719f89.preview.bl.run/app) and [Manufact MCP](https://fast-wave-awovc.run.mcp-use.com/mcp) use the same API. Ready logs and public health passed, with `database: "ok"`, test payments and no missing provider settings. The web allocation is 2048 MiB, process keep-alive is false, and the actual deletion policy is `ttl-idle: 24h` for judging. The helper still defaults to one hour unless `--idle-ttl 24h` is supplied. Standby avoids active compute charges; retained images and snapshots can incur storage charges. R7 adds one responsive text-wrapping rule to the verified r6 application; the completed paid-flow proofs below retain their actual r6 execution provenance.

| Boundary | Actual evidence |
| --- | --- |
| Supabase | Existing account, new MediaPack project on Free in Oregon; checksummed migrations 0001/0002 applied and idempotent, 12 public app tables with RLS, private bucket and project-wide upload limit both exactly 52,428,800 bytes; trusted CA verification enabled |
| Browser and uploads | Secure/HttpOnly session creation, two-owner isolation, real signed Storage PUT and byte/SHA identity; post-PUT reservation retry fixed and verified against the cloud |
| Stripe | Persistent test key verified against the exact MediaPack sandbox; explicit `STRIPE_TEST_NETWORK_ID=internal`, real MPP 402/credential/receipt round trip, owned test webhook, signature rejection and deduplication |
| Primitive | Persistent keys; app-owned enabled receiver; real work requests and results persisted and applied for both source videos |
| Blaxel and models | 4096 MiB workers; dedicated workspace service account kept on the server; only short-lived OAuth model tokens forwarded; real gateway vision and search against fixture evidence |
| Audio | Packaged, checksum-pinned whisper.cpp 1.9.5/base; actual talk indexing transcribed 44.9 seconds of audio in 8.598 seconds without an audio API |
| Manufact | Same public `/mcp` and server, active r6 deployment, nine tools, caller-owned reads, view assets and error forwarding; final source-specific search submitted once and answered correctly; sole cloud environment setting is the current API origin |
| Recovery | Private Vault/HMAC/nonce scheduler; controlled missed-dispatch recovery in 34.585 seconds, followed by an idle cron run with zero HTTP requests; final r6 origin and signed tick/replay/tamper checks verified, with 300-second nonce retention |

The internal Stripe setting is explicitly test-only. It does not invent a profile, weaken live-mode checks or establish public Link-wallet compatibility. A genuine Stripe profile remains necessary for that wallet path. The current test-helper API rejects optional seller details; the buyer follows the installed SDK's single compatibility retry only after a definitive unsupported-parameter response. Unknown payment outcomes are never retried by purchasing again.

The authored fixture recordings passed actual upload, probe, quote and payment paths:

| Source | Payment | Index and evidence |
| --- | --- | --- |
| `talk-sample.mp4` | One USD 0.50 test PaymentIntent; repeat purchase returned the same receipt and one payment attempt | 23 visual frames and 9 local speech records; correctly cited Sunday 10 AM, repository link and two-minute demo; two SHA-verified frames plus a six-second H.264/AAC clip, fully decoded with ffmpeg |
| `settings-reset.mp4` | One USD 0.50 test PaymentIntent; one entitlement, payment attempt and index operation | 27 correctly indexed frames; final r6 MCP search correctly reports 30 after reload versus saved 60, citing `f_0021` and `f_0024` at 40–48 seconds. Actual source frames at 40/46 seconds visibly confirm both values; the eight-second H.264 1280×800 clip at 40–48 seconds passed SHA-256 and full ffmpeg decoding. All 15 runtime assertions passed |

The first retained-resource launch failures exposed an opaque provider error. After deleting only completed, verified task workers and superseded web hosts, the same paid packs resumed without another payment. The exact provider quota was not returned, so resource contention remains an inference. The final launcher safely reclaims completed owned workers before provisioning and reports bounded, redacted provider errors. A real service-account check reclaimed four completed workers; the final deployed frame-launch path also reclaimed its completed current-image search worker. The superseded r5 web host was removed after r6 verification. Migration 0002 and the final control code separate `worker.claimed` from factual `worker.launched`; actual launched identities are committed atomically after SDK confirmation. Historical failed attempts and their older events remain preserved.

The temporal correction reviews the entire chronological index, records relevant source observations before the answer, considers later contradictory field text, and cites both states of a transition. Two real gateway regressions against the persisted settings index and one against the persisted talk index passed before deployment, without spending app allowance or inserting expected answers into model inputs. The final MCP search then passed on the new cloud worker using the existing paid index.

Final checks: 65 backend tests passed; 39 worker tests passed, including actual CPU Whisper, ffmpeg and transport; all 42 SQL invariants passed on a fresh disposable PostgreSQL database with both migrations; 31 Stripe setup/buyer tests passed; 17 Supabase setup tests passed, including the real PostgreSQL upgrade/idempotency check. The 11 web tests, focused lint and final image build/TypeScript passed. Browser QA passed visible test labeling, keyboard upload controls, the video-memory disclosure, session creation, pairing, actual unpaid payment instructions and asset loading. A long next-action URL exposed phone-width overflow on the unpaid job page; r7 applies `overflow-wrap:anywhere` to that status paragraph. The existing third-party Tempo dynamic-import build warning remains. The [efficiency explanation](efficiency-and-memory.md) distinguishes historical measured token counts from projected savings and competing products.

The settings pack finished with three searches, four source frames, 14,000 ms of clips and 834 evidence characters consumed; every reservation is zero. Exact frame/clip request retries preserved the same operations and ledger, and retrying the quote returned the same PaymentIntent. The talk pack used a different source and returned its own 22–31.44-second deadline evidence. Neither retry recovery nor the temporal correction required another purchase or another index.

R6 recovery passed a 71-second database-only idle observation containing a successful scheduled cron run. R7 repeated all 12 recovery checks: signed request 200, replay/tampering 401, approximately 300 seconds of nonce retention, the correct Vault origin, and 70.493 idle seconds containing two successful cron runs with zero new pg_net responses or queued HTTP requests. The historical interrupted-dispatch recovery remains a separate 34.585-second proof.

Final r7 readback passed. Both owned provider callbacks are enabled on the new origin; signature rejection, durable receipt and deduplication passed. The same Manufact server is active on deployment `4c0f3b54-55af-4367-8ed7-a74f9ff09fbe`, with only `MEDIAPACK_API_URL` configured. Caller-owned `get_job`/`get_pack` returned the persisted correct search and existing four frames/two clips; usage, reservations and operation IDs stayed unchanged. All nine tools and view assets passed. No new search or purchase was needed for the CSS release.

Actual-source browser checks passed at widths 375 and 1280 for both payment instruction tabs, with no DOM patches or horizontal overflow. The commands use the current origin and verified sandbox CLI, state the same-owner requirement, and explain the real-profile requirement for Link. Pairing, the memory disclosure, keyboard focus and all 40 observed static asset requests passed, with no browser console errors or warnings. This is Stripe test mode; public Link wallets and Blaxel Application Runtime remain separate optional account features, not capabilities proved by this release.

Final scoped cleanup removed the superseded r6 host and two eligible completed workers through the guarded reaper. The provider list then contained only `mediapack-web-r7`, deployed and in standby. Retained images remain subject to their separate storage rate.

Private runtime evidence is stored in ignored mode-0600 `.blaxel/*-proof.json` files; downloaded media and owner state remain private. Source hashes, non-secret test identifiers, actual timestamps and failed attempts are preserved. No owner capability, SPT, signing secret, service credential or signed artifact URL belongs in this public record.

## Historical local and deployment records

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

Stripe CLI 1.54.0 was installed through Homebrew and its official Projects plugin 0.50.0 was installed successfully. Installed help was inspected for `init`, `catalog`, `add`, `env` and `link`. The plugin's local subprocess handshake required execution outside the restricted process sandbox. A live unauthenticated `catalog supabase --json --interactive=false` request succeeded, listing Free ($0), Pro ($25/month), Team and the project deployable. Native device login subsequently completed. Projects initialization then returned `PROJECTS_CONTEXT_MISMATCH`: the CLI had only sandbox access, while Projects requires live-mode infrastructure credentials. The suggested native context switch was rejected because that account had no authorized live access. At the user's request, logout succeeded and a fresh native login was started so the parent business can grant access. That browser approval remains pending. No project, provider resource, payment method or paid subscription was created.

On October 18, 2026, the user selected Supabase Free. The previous 100 MiB source limit was lowered to 50 MiB (52,428,800 bytes) across browser preflight, REST contracts, MCP validation, agent CLI, worker validation and private bucket setup. Stripe app payments remain in test mode; Projects infrastructure authorization is independent. No paid plan is authorized. Blaxel credits do not establish a Supabase billing allowance.

`scripts/setup-supabase.mjs` now provides a read-only plan and an explicit apply step for an already-provisioned project. It applies ordered migrations in atomic transactions, tracks filename/SHA256, locks concurrent setup, refuses untracked or inconsistent app objects, and configures/read-checks the private bucket. It explicitly reports the project-wide upload cap unverified. Fifteen tests passed, including a fresh local PostgreSQL 17 process with boot logs checked, all 12 actual migration tables and RLS, idempotent reapplication, and rollback of both failed DDL and its checksum record. That scratch cluster was stopped and removed. Storage network I/O was replaced at its adapter boundary; no actual Supabase credential or storage endpoint has been exercised.

The Free-policy update passed 26 backend tests, 30 worker tests, 15 Supabase setup tests (including the actual disposable Postgres check), 11 web tests and 11 MCP tests; web lint and production build; MCP typecheck, production build and runtime smoke; and Blaxel's local packaging preflight. The worker's restricted run passed the media checks but could not bind its transport fixture on loopback (`EPERM`); those six transport checks passed with loopback permission. The existing third-party Tempo dynamic-import build warning remains.

A freshly started standalone Next.js production server connected to a fresh disposable PostgreSQL cluster and reported database OK. Its ready logs were checked; the dashboard displayed the 50 MB limit and all 12 referenced browser assets returned 200. Browser bootstrap returned 201 with a Secure, HttpOnly cookie. Through the compiled Next.js HTTP routes, an exact 52,428,800-byte declaration returned 201 and signed PUT instructions, one extra byte returned actionable 400 before calling Storage, and a retry reused the same reservation. The database contained one video row, and a second owner received 404. Only the Supabase Storage HTTP boundary was replaced by a local fixture; this proves local database/session/validation wiring, not a cloud upload. The owned Next.js process, fixture server and disposable cluster were stopped after the check.

Stripe Projects' `.projects` vault and generated skills are excluded from Blaxel source archives and Docker context; the preflight rejects their inclusion. The local archive/configuration preflight passed. The existing deployed app has not been restarted with Supabase settings because account provisioning remains pending.

### Primitive account connection

Native CLI browser login succeeded in the existing account. Authenticated account/domain/endpoint/signing-secret/send-permission reads returned 200, with one verified active managed domain and no endpoints before setup. The setup helper now saves only the existing account signing secret and service addresses privately (env mode 0600), and records ownership of one disabled org-wide HTTP endpoint. CLI OAuth access/refresh tokens are not copied into the app. The first endpoint request was rejected with HTTP 400 because a pull-only `name` was included; removing it produced a successful create. A subsequent plan found the saved endpoint and proposed reuse rather than creating a duplicate. All 12 setup tests pass, including ownership, idempotency, URL rotation, unrelated-route preservation, OAuth token exclusion, private env preservation and safe errors.

The web process was restarted with those settings while retaining `keepAlive: false` and one-hour idle deletion. A correctly signed **empty ignored** webhook payload returned 200; a tampered signature returned 401. Health reports `primitive_webhook: true`, but `primitive: false` and database unconfigured. This proves public receiver configuration and signature validation only. No mail or provider test delivery was sent, and event persistence/work request/reply remains unverified. A persistent runtime Primitive API key is still absent. The endpoint remains disabled pending credentials and a working database.

### Blaxel model gateway

The existing `sandbox-openai` model gateway is deployed/enabled with configured model `gpt-4o-mini`. Empty POST validation (no inference) returned provider input-validation 400 responses on Responses/chat, while audio transcription returned 403 endpoint-not-allowed. Local native CLI authentication works; the custom sandbox has no injected OpenAI/Blaxel API credentials, and its mounted identity token returned 401 for ordinary model/API use. This is evidence for an available gateway route, not a completed worker integration or successful model processing. Current worker source still uses the direct OpenAI adapter. See the integration notes for precise limitations.

Record the actual Next.js build/runtime checks, database/worker test results, and provider smoke results with versions and times. For the credentialed end-to-end run, preserve redacted video/job/payment/operation/Primitive-message/artifact IDs. Demonstrate a new video's source digest, grounded arbitrary search, source frames and playable clip; repeat with a different video and verify ownership and retry behavior. Publish no owner capabilities, SPTs, signed URLs or account secrets in the run manifest.
