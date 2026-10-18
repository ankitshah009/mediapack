# Primitive + Blaxel integration notes (MediaPack)

> Dated research and account findings. Later examples include historical hosting and worker proposals; [build decisions](../../DECISIONS.md) describe the implemented Next.js and Node worker topology. Use [account setup](../SETUP-ACCOUNTS.md), [costs](../blaxel-costs.md) and [verification](../verification.md) for current operator guidance and executed checks.

Researched 2026-10-17 from primary sources (docs.primitive.dev, primitive.dev OpenAPI, docs.blaxel.ai, blaxel.ai/pricing, PyPI).
Legend: **VERIFIED** = read on the cited page today. **UNVERIFIED** = inferred, or the docs are silent. Prove it with a live call before relying on it.

## Current account verification (2026-10-17)

- The official Primitive CLI 1.65.0 was installed under `/tmp/mediapack-primitive-cli`, and browser login to the user's existing account succeeded. No global package or separate account was created.
- Authenticated account, domain, endpoint, signing-secret and send-permission reads returned 200. A managed domain is verified and active; endpoint discovery was empty. Private values are retained only in the ignored `.blaxel` directory and server environment file, never in this document.
- The CLI OAuth access token expires in one hour and has a refresh token for the local CLI. Do not copy either into a long-running server as an API key. A persistent `PRIMITIVE_API_KEY` is required for the app and worker; the existing server adapter/worker reply sink are already implemented against the official SDK.
- The current CLI/API describes managed-zone recipients as allowed without a recipient entitlement. This supersedes the older managed-address opt-in observation below; actual account send permissions are authoritative. No live mail was sent by this verification.
- The org-scoped webhook signing secret is retrievable from `GET /account/webhook-secret`; the initial read may generate it, while explicit rotation would invalidate existing verifiers and is not part of setup.
- The deployed receiver persists verified events before acknowledging them. Keep its endpoint disabled while Supabase is unconfigured; a signing secret alone does not establish successful work delivery.

### Existing Blaxel model gateway

`sandbox-openai` exists and is deployed/enabled in `mediapack`, with provider OpenAI and configured model `gpt-4o-mini`. Its OpenAI-compatible base is `https://run.blaxel.ai/mediapack/models/sandbox-openai/v1`. Local Blaxel CLI authentication works via SDK `settings.authenticate()` and `settings.headers`, without a raw OpenAI API key.

Empty POST requests (no inference, no user media) verified `responses` and `chat/completions` return input-validation 400 responses; `audio/transcriptions` returns 403 `Endpoint not allowed on sandbox model`. This verifies route availability, not successful structured vision/search inference or its billing terms. Existing worker code still needs a gateway adapter, the configured model without a reasoning parameter, and supported hosted Blaxel authentication. ASR requires another permitted endpoint or local transcription.

Inside the actual nonroot web sandbox, `OPENAI_API_KEY`, `BL_API_KEY` and `BL_CLIENT_CREDENTIALS` were absent. Its mounted identity token was readable but returned 401 for ordinary Blaxel API/model authentication; it must not be treated as a general gateway credential. Do not assume automatic OpenAI secret injection from the existence of the gateway. Sources: [Blaxel model queries](https://docs.blaxel.ai/Models/Query-a-model), [OpenAI integration](https://docs.blaxel.ai/Integrations/OpenAI), and the authenticated validation above.

Note: the docs fetcher only returned short quotes for long code blocks, so some snippets below are excerpts. Full blocks are at the cited URLs.

---

## 1. Primitive (primitive.dev): email for agents

### 1.1 Signup, API key, auth
- Sign up at https://www.primitive.dev/signup. Each org gets a managed subdomain such as `brave-otter.primitive.email`, and MX and outbound records are published automatically. **VERIFIED** (https://docs.primitive.dev/docs/quickstart)
- API key: **Settings -> API keys** (https://www.primitive.dev/app/settings/api-keys), stored as `PRIMITIVE_API_KEY`. Webhook signing secret: **Settings -> Webhooks**, stored as `PRIMITIVE_WEBHOOK_SECRET`. **VERIFIED** (quickstart)
- API base `https://api.primitive.dev/v1`, auth header `Authorization: Bearer prim_<api_key>`. **VERIFIED** (https://www.primitive.dev, https://www.primitive.dev/llms-full.txt)
- CLI: `brew install primitivedotdev/tap/primitive` or `npm install -g primitive` (Node 22+), then `primitive login` (OAuth). **VERIFIED** (quickstart)
- Pricing (https://www.primitive.dev/pricing.md). **VERIFIED**
  - Developer: $0/mo with a $5/mo usage credit, no card required. Free tier limits: "a single global (org-wide) webhook, and per-domain endpoints require a paid plan" (https://docs.primitive.dev/docs/endpoints).
  - Power: $13/mo with a $13 credit. Platinum: $299/mo.
  - External sends: 1,000/h and 10,000/day. Primitive-to-Primitive sends on Developer: 1,000/h and 10,000/day. API: 3,000 req/min.
  - Functions: $1 per 1,250 invocations, plus $1.32 per runtime hour.

### 1.2 SDK packages: VERIFIED (https://docs.primitive.dev/docs/sdks, PyPI)
| Lang | Package | Runtime | Import |
|---|---|---|---|
| TS/Node | `@primitivedotdev/sdk` (`npm i @primitivedotdev/sdk`) | Node 22+ | `import primitive from '@primitivedotdev/sdk'`, plus `'@primitivedotdev/sdk/api'` for low-level helpers |
| Python | `primitivedotdev` (`pip install primitivedotdev`) v2.4.0 | PyPI says `>=3.11` (the docs page says 3.10+) | `import primitive` / `from primitive import verify_webhook_signature` |
| Go | `github.com/primitivedotdev/sdks/sdk-go` | Go 1.25+ | |

Source: https://github.com/primitivedotdev/sdks. Python 3.14 compatibility is only implied by `>=3.11` with no upper bound. **UNVERIFIED** until we install it.

```ts
// Node (excerpt, docs/sdks + docs/sending)
const client = primitive.client({ apiKey: process.env.PRIMITIVE_API_KEY! });
const result = await client.send({ /* from, to, subject, */ bodyText: 'Your order is on its way.', wait: true });
console.log(result.id, result.deliveryStatus, result.smtpResponseCode);
```
```python
# Python (excerpt, docs/sdks + docs/sending)
client = primitive.client(api_key=os.environ['PRIMITIVE_API_KEY'])
result = client.send(from_email='support@yourdomain.com', body_text='Your order is on its way.', wait=True)  # + to/subject
print(result.id, result.delivery_status, result.smtp_response_code)
```

### 1.3 Send a message: `POST https://api.primitive.dev/v1/send-mail`. VERIFIED (OpenAPI `SendMailInput`, https://docs.primitive.dev/docs/sending)
- Required fields: `from`, `to`, `subject`. At least one of `body_text`/`body_html` is required, and the two combined must be **at most 262,144 bytes**. Our JSON job envelope goes in `body_text`.
- Optional fields: `cc`, `bcc`, `in_reply_to`, `references[]`, `attachments[]` (≤100 files, **≤30 MiB total decoded**), `payload_attachments[]` (max 1, see 1.5), `wait`, `wait_timeout_ms` (≤30000), `scheduled_at`, `headers`, `tags`.
- `from` must be a verified outbound domain of the org.
- Header `Idempotency-Key` (≤255 chars). If omitted, Primitive derives one from the payload and "an identical second send in that window [5 min] is not sent". A replay returns `idempotent_replay: true` and the header `Idempotent-Replayed: true`. **VERIFIED** (llms-full.txt, OpenAPI)
- **Gotcha:** new orgs are send-gated. Sending to managed `*.primitive.email` addresses is an org-level setting that is **off by default**, and new accounts can only send to known external addresses at first. A denied send returns `403 recipient_not_allowed` with `gates[]` and `fix.action`. **VERIFIED** (https://docs.primitive.dev/docs/faq, docs/sending). Enable this setting before the demo.

```bash
curl -X POST https://api.primitive.dev/v1/send-mail \
  -H "Authorization: Bearer $PRIMITIVE_API_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: dispatch-MP-1042" \
  -d '{"from":"api@<org>.primitive.email","to":"worker@<org>.primitive.email",
       "subject":"[MP-1042] index","body_text":"{\"job_id\":\"MP-1042\",\"media_ref\":\"<supabase signed url>\"}"}'
```
(Field names are from the OpenAPI spec. The exact command was assembled by us and has not been run. **UNVERIFIED**)

### 1.4 Receive inbound: VERIFIED (https://docs.primitive.dev/docs/receiving, /endpoints, /webhook-payload, /signature-verification)
There are three delivery modes. `CreateEndpointInput.kind` is one of `http | function | pull`.
1. **HTTP webhook** to a URL we host. The URL "must be HTTPS and publicly reachable; private and loopback hosts are rejected." Create it with `POST /v1/endpoints {"kind":"http","url":"https://…","domain_id":null,"rules":{}}`.
2. **Primitive Function**: hosted JS, Workers-style `fetch(request, env)`. "Wall-clock: up to 10 minutes per invocation". 128 MiB memory. Secrets via `primitive functions:set-secret`. Overrunning is marked `function_timeout` and retried.
3. **Pull**: `POST /v1/endpoints/{id}/pull` long-polls up to 30 s per event, and you ack with `/complete`. Queue retention is 24 h. Caveat: "Only connected-agent credentials can create pull destinations, and each receives only its assigned address." (OpenAPI)

Fallback polling: unrouted mail "is still stored and can be read from the REST API". Use `GET /v1/emails` (with `thread_id` filter), `GET /v1/emails/{id}`, and `GET /v1/threads/{id}`.

Routing: `POST /v1/routes` binds a **recipient address pattern** (`exact` or `wildcard`; `regex` needs Power+) to exactly one `endpoint_id` or `function_id`. Endpoints created with `is_route_target: true` are exempt from the one-per-domain rule. Unmatched mail goes to the domain default, then the org default, then is stored. **VERIFIED** (https://docs.primitive.dev/docs/routing). Routes are "plan-limited by count", and the free-plan count is not stated. **UNVERIFIED**

Signature: header `Primitive-Signature: t=<unix-seconds>,v1=<hex-hmac>`, which is HMAC-SHA256 over `"<timestamp>.<raw-body>"` with the webhook secret. Verify against the raw body before parsing. The tolerance window is up to us. **VERIFIED**
```ts
// Next.js route (docs/receiving): verifies + parses
import primitive from '@primitivedotdev/sdk';
export async function POST(req: Request) {
  const email = await primitive.receive(req, { secret: process.env.PRIMITIVE_WEBHOOK_SECRET! });
  return Response.json({ ok: true });
}
```
```python
# Python (docs/signature-verification, excerpt)
from primitive import WebhookVerificationError, verify_webhook_signature
verify_webhook_signature(raw_body=raw_body,
    signature_header=request.headers.get('Primitive-Signature', ''),
    secret=os.environ['PRIMITIVE_WEBHOOK_SECRET'])
```

Payload `email.received` (webhook-payload page), **VERIFIED**:
- top-level `id`: the delivery event id, "stable across retries and manual replays … Use it for webhook dedupe."
- `email.id`: used for the REST calls.
- `email.thread_id`
- `email.headers.message_id`
- `email.parsed.in_reply_to[]` and `email.parsed.references[]`
- `email.parsed.attachments[]`, plus `attachments_download_url` (tar.gz)
- `email.content.raw` is inline only up to `max_inline_bytes` (262,144 in the example). Larger content is at `email.content.download.url`, which expires in 24 h.
- Headers: `X-Webhook-Event`, `X-Webhook-Id`, `Primitive-Signature`.

### 1.5 Large payloads ("no attachment size limit" = Primitive Payloads)
- "Primitive Payloads lets you send and receive files of any size by email". Storage caps: Developer 5 GB (hard cap), Power 10 GB, Platinum 50 GB. **VERIFIED** (https://docs.primitive.dev/docs/limits, pricing.md)
- Mechanism: upload the object via `/v1/payloads` "with a client-held CEK the server never sees". Then send with `payload_attachments: [{root:<64-hex merkle root>, filename, content_type?, cek}]`. v1 allows only 1 per message. **VERIFIED** (OpenAPI `SendMailPayloadRef`)
- The `/v1/payloads` upload API itself is **not** in the public OpenAPI path list, and `docs.primitive.dev/docs/payloads` returns 404. The upload protocol is **UNVERIFIED**.
- **Recommendation:** do not use Payloads on the critical path. Pass Supabase Storage signed URLs and paths in the JSON body. That is smaller, already free, and avoids an undocumented upload flow.

### 1.6 Correlation and threading
- To reply, use `POST /v1/emails/{inbound-id}/reply` (`body_text`), `client.reply(email, {text})` in Node/Python, or the CLI `primitive sending:reply-to-email --id <id> --body-text "..."`. Primitive derives the recipient, the `Re:` subject, `In-Reply-To`, and `References`. **VERIFIED** (quickstart, docs/sdks)
- Raw sends can set `in_reply_to` and `references` directly. **VERIFIED** (OpenAPI)
- MediaPack correlation should be belt-and-braces:
  - put `job_id` in the subject (`[MP-1042]`) **and** in the JSON body
  - store our outbound `sent_email.id`, then match the reply by `email.thread_id` or `parsed.in_reply_to`
  - treat `job_id` as the source of truth.

  Whether the send response returns the RFC Message-ID or the `thread_id` is not documented. **UNVERIFIED**

### 1.7 Delivery guarantees and duplicates
- "Primitive retries webhook delivery when your endpoint does not return a 2xx response". Network failures are also retried. **VERIFIED** (docs/receiving)
- The retry schedule is documented for `sent_email.*` events only: a retry when there is no 2xx within **10 s**, then at about 5 min, 30 min, 2 h, and 8 h, for at most 5 attempts. **VERIFIED** (webhook-payload). The inbound `email.received` timeout and schedule are not stated. **UNVERIFIED**, so assume ~10 s and ack fast.
- The delivery model is effectively at-least-once. Dedupe on the top-level event `id`, and do not use `delivery.attempt`. **VERIFIED** (webhook-payload, FAQ)
- Manual replay: `primitive emails:replay-email-webhooks --id <email-id>` or `POST /v1/webhooks/deliveries/{id}/replay`. **VERIFIED**

### 1.8 Can inbound POST directly to a Blaxel URL?
- Yes in principle: any public HTTPS URL is accepted, but private and loopback hosts are not. **VERIFIED**
- **No custom request headers** can be configured on an endpoint (the docs don't mention any), so Primitive **cannot** send `X-Blaxel-Authorization`. **UNVERIFIED** (absence in docs). This means the Blaxel target must be **public** and must authenticate the caller by checking `Primitive-Signature` itself.
- On the free plan there is only one org-wide webhook. Splitting api@ and worker@ to different targets needs routes with `is_route_target` endpoints, whose free-plan allowance is **UNVERIFIED**, or a paid plan ($13 Power).

### 1.9 MCP: VERIFIED (llms-full.txt)
- `https://www.primitive.dev/mcp`: Streamable HTTP, Bearer `prim_…` or OAuth, registry name `dev.primitive/email`.
  - Read tools: `getAccount`, `getInboxStatus`, `listEmails`, `searchEmails`, `getEmail`.
  - Actions: `sendEmail`, `replyToEmail`.
- Docs MCP: `https://www.primitive.dev/mcp/docs`.

---

## 2. Blaxel (blaxel.ai): agent cloud

### 2.1 CLI and auth: VERIFIED (https://docs.blaxel.ai/Get-started.md)
```bash
brew install blaxel-ai/blaxel/blaxel && bl setup   # or: curl -fsSL https://blaxel.ai/install.sh | sh
bl login                                           # browser login to a workspace
export BL_WORKSPACE=my-workspace BL_API_KEY=...     # for SDK/CI; key from console security page
bl new agent | bl new job | bl new mcp | bl new sandbox <name>
bl serve        # local
bl deploy       # uses root Dockerfile if present
```
"Deployed resources authenticate automatically" to the Blaxel API, so a deployed agent can start a job with no key. **VERIFIED** (Get-started)

### 2.2 SDKs: VERIFIED
- TypeScript: `@blaxel/core` (`SandboxInstance`, `blJob`, `env`).
- Python: `blaxel` v0.4.18, `requires_python <3.15,>=3.10`. **Python 3.14 is supported.** (https://pypi.org/pypi/blaxel/json)

### 2.3 Compute primitives compared
| Primitive | Endpoint | Max duration | Fit |
|---|---|---|---|
| **Agent** (Agents Hosting) | `POST https://run.blaxel.ai/{ws}/agents/{name}` (sync). Async via `?async=true` or a `http-async` trigger. | "maximum runtime of 15 minutes"; sync closes after **100 s with no data** (streaming resets it); async "dozens of seconds to 10 minutes" / "up to 15 minutes"; async trigger timeout "max 900s" | Clip/frame HTTP API. Primitive inbound receiver. |
| **Job** (Batch Jobs) | `POST https://api.blaxel.ai/{ws}/jobs/{name}/executions` with `{"tasks":[...]}` | `[runtime] timeout` in seconds, examples 900 and 3600, **no stated max**; `maxRetries`, `maxConcurrentTasks` | **Indexing** (minutes-long, retryable, cheapest compute) |
| **Sandbox** | Preview URL `https://<id>.<region>.preview.bl.run`, public or token-protected | 15-min connection timeout; "enter standby when they have no active connections, even if processes are still running" | Not for unattended multi-minute work |
| Application | generated public URL | n/a | "private preview … not recommended for production" |

Sources: https://docs.blaxel.ai/Agents/Overview, /Agents/Query-agents, /Agents/Deploy-an-agent, /Jobs/Deploy-a-job.md, /api-reference/jobs/create-batch-job.md, /Sandboxes/Overview.md, /Sandboxes/Preview-url.md, /knowledge-base/configuration-and-operation/sandbox-inactivity-with-long-running-processes.md, /Applications/Overview.md. All **VERIFIED**.

**Why sandboxes are wrong for the worker:**
- A sandbox goes to standby about 15 s after its last connection, "even if processes are still running". The docs do not say whether the process is frozen. Either way it requires an external poller (`process.wait({maxWait, interval})`) to stay alive.
- The 25 ms resume ("resume from standby in under 25 milliseconds"), **VERIFIED**, is great for interactive tools but irrelevant to a 5-minute ffmpeg+whisper run.

**Python and ffmpeg:**
- Agents Hosting "only supports applications developed in Python and in TypeScript" and must bind `HOST`/`PORT`. **VERIFIED**
- Custom Dockerfile: "you can also deploy your workload using your own Dockerfile" (agents). Jobs: a root `Dockerfile` is used by `bl deploy`, and "The entrypoint must run a function that terminates". **VERIFIED** (/Agents/Deploy-an-agent, /Jobs/Deploy-dockerfile-jobs.md)
- So `FROM python:3.14-slim` plus `apt-get install ffmpeg` works. Running that exact image on Blaxel is **UNVERIFIED** (not yet built).
- The Dockerfile-jobs page comments "port 80 for agents" but uses 1338 in its job example. Read `PORT` from env.
- Sandbox images must `COPY --from=ghcr.io/blaxel-ai/sandbox:latest /sandbox-api /usr/local/bin/sandbox-api`. **VERIFIED** (/Sandboxes/Templates.md)

**Job task input (Python):** the template `blaxel-templates/template-jobs-py/src/main.py` launches via `bl_start_job.start(my_job)`. **VERIFIED** (GitHub raw). The exact import path and the arg shape (one task dict per call) are **UNVERIFIED**: copy from `bl new job`.

### 2.4 Auth and public URLs: VERIFIED (/Agents/Query-agents, /deployment-reference.md, /Jobs/Deploy-a-job.md)
- Private calls need `X-Blaxel-Authorization: Bearer <token>` and `X-Blaxel-Workspace: <ws>`. The applications API example uses `Authorization: Bearer $BL_API_KEY`.
- `public = true` at the root of `blaxel.toml` (agent only, default `false`) makes the agent callable with no Blaxel auth.
- Triggers: `http` (agent/function), `http-async` (agent, `path`, `retry`), `cron` (job). Function http triggers take `authenticationType = "public"|"private"`.
- Async callback URL: an "optional callback URL" exists, but its parameter name and signing are undocumented. **UNVERIFIED**

### 2.5 Secrets: VERIFIED (/Jobs/Variables-and-secrets-jobs.md)
- `.env` at the project root is read at `bl deploy`, or use `bl deploy --env-file <file>`.
- Read them at runtime with `os.environ` or `env.X` in TS.
- `[env]` in `blaxel.toml` is "NOT secrets".

### 2.6 Pricing: VERIFIED (https://blaxel.ai/pricing)
- Sandboxes: $0.0000115 per GB-RAM-second active (about $0.041/GB-h); standby snapshots $0.20/GB-month; images $0.045/GB-month.
- **Jobs: $0.000006 per GB-RAM-second** (about $0.022/GB-h). A 10-min index at 4 GB costs about **$0.014**.
- Agent Runtime compute: "Coming soon" (price not published). MCP hosting: $0.000007 per GB-s.
- "Up to $200 in free credits". Tiers unlock by 30-day top-up volume, and "Promotional credits do not unlock tiers" (/Security/Quotas.md). Per-tier limits are only visible in the console Quotas tab. **UNVERIFIED** values.

---

## 3. Recommended topology

```
Vercel API ──send-mail──> Primitive ──http endpoint──> Blaxel AGENT "mediapack-worker" (public, Dockerfile, py3.14+ffmpeg)
   ^  (from api@, to worker@)          (route worker@)        │ POST /primitive: verify Primitive-Signature,
   │                                                          │ dedupe event id, blJob("mediapack-index").run([task]) → 200 in <1s
   │                                                          v
   │                                          Blaxel JOB "mediapack-index" (same image, timeout=3600, maxRetries=1)
   │                                            download Supabase signed URL → ffmpeg/whisper → write Supabase
   │                                            → primitive client.send(to=api@, in_reply_to=<orig Message-ID>,
   │                                                 Idempotency-Key=index-done-<job_id>, body=JSON refs)
   │                                                          │
   └──── POST /api/webhooks/primitive <── Primitive (route api@ → Vercel http endpoint) ┘
Vercel API ──HTTPS + Bearer──> Blaxel AGENT /clip, /frames (same agent; sync, <100 s; private token checked in-app)
```

1. **Dispatch.** The API calls `client.send({from:'api@<org>.primitive.email', to:'worker@<org>.primitive.email', subject:'[MP-1042] index', bodyText: JSON.stringify({job_id, media_ref, callback:'api@…'})})`. The `Idempotency-Key` is `dispatch-<job_id>`, and `sent_email.id` is stored in `events`.
2. **Primitive to Blaxel.** Create `POST /v1/endpoints {"kind":"http","url":"https://run.blaxel.ai/<ws>/agents/mediapack-worker/primitive","is_route_target":true}`, then `POST /v1/routes {"match_type":"exact","pattern":"worker@<org>.primitive.email","endpoint_id":…}`. That the Blaxel run URL forwards sub-paths to our server is **UNVERIFIED**. If it doesn't, have the server accept the POST at `/` and branch on the `Primitive-Signature` header.
3. **Worker agent `/primitive` acks fast.** Primitive likely retries after about 10 s. The handler verifies the HMAC, upserts the event `id` into a Supabase `dedupe` table, calls `blJob("mediapack-index").run([{job_id, media_ref, reply_to_email_id: email.id}])` (deployed resources auto-auth), and returns 200.
4. **Index job.** It runs for minutes, then writes `segments`/`events` to Supabase (Realtime drives the UI). It finishes by replying through Primitive with `POST /v1/emails/{email.id}/reply` or the SDK `client.reply`. That threads automatically, so the reply lands on api@ in the same `thread_id`.
5. **API webhook.** `/api/webhooks/primitive` calls `primitive.receive(req, {secret})`, dedupes on event `id`, parses `job_id` from the subject or body, and sets `jobs.status='indexed'`. Results live in Supabase. The email carries only refs.
6. **On-demand evidence.** The API calls `POST https://run.blaxel.ai/<ws>/agents/mediapack-worker/clip` with headers `X-Blaxel-Workspace` and `X-Blaxel-Authorization: Bearer <BL_API_KEY>`. Because the agent is `public=true` for step 2, also require an app-level `Authorization: Bearer <MEDIAPACK_WORKER_TOKEN>`. Uploads go to Supabase, and the call returns signed URLs. Keep each call under 100 s, or stream progress bytes.

**Prerequisites:**
- Enable sending to managed `*.primitive.email` addresses in Primitive org settings.
- On the free plan, confirm routes and route-target endpoints are allowed, or buy Power for $13.

**Cost per index:** about 2 Primitive sends (inside the free credit) plus about $0.01–0.03 of Blaxel job compute. There is no LLM spend on this path.

## 4. Fallback (Primitive can't deliver straight to Blaxel)

Triggers for this fallback:
- the free plan allows only one org-wide webhook
- route-target endpoints are blocked
- the run.blaxel.ai public URL rejects the POST
- we don't want a public worker

**Fallback A (preferred, zero extra infra):** use one org-wide Primitive webhook pointed at Vercel `/api/webhooks/primitive`.
- The handler branches on the recipient.
  - `to == worker@…` (the dispatch we sent ourselves): call the Blaxel Job API directly with `POST https://api.blaxel.ai/<ws>/jobs/mediapack-index/executions`, headers `X-Blaxel-Workspace` and `X-Blaxel-Authorization: Bearer $BL_API_KEY`, body `{"tasks":[{job_id, media_ref, reply_to_email_id}]}`.
  - `to == api@…` (the worker's reply): mark the job indexed.
- Primitive stays the visible request/reply bus with threading and audit, and the worker stays private.

**Fallback B (no Vercel hop):** use a Primitive Function bound with `--fallback`.
- It verifies the signature, then makes the same `fetch` to the Blaxel executions API, with `BL_API_KEY` set via `primitive functions:set-secret`. Use `AbortSignal.timeout(30_000)`.
- That outbound fetch is allowed is **UNVERIFIED**: the docs list it as a use case but don't state it.

**Fallback C (fully decoupled):** the job, or a cron job, polls `GET /v1/emails?thread_id=…` or uses a pull endpoint.
- Pull needs connected-agent credentials, which is **UNVERIFIED** for our account type.

In every variant, the reply path (job to `client.reply` to Vercel webhook) is unchanged. Supabase is the system of record, so a lost email degrades to "status visible via Realtime, reply late" rather than data loss. Add a watchdog: if the job finished in Supabase but no reply arrived within 2 min, the API polls `GET /v1/emails?thread_id=…`.

## 5. Open verifications (do first, about 15 min)
1. `pip install primitivedotdev blaxel` on 3.14 in a venv, then import `primitive` and `blaxel`.
2. Send a test from api@ to worker@ to confirm the managed-address gate is on.
3. `POST /v1/routes` on the free plan, and observe whether it returns 402 or 403.
4. `bl deploy` a public agent, then `curl -X POST https://run.blaxel.ai/<ws>/agents/<name>/primitive` to check sub-path routing and that no auth is needed.
5. From inside the agent, `blJob(...).run()` with no key, to prove auto-auth.
6. Measure Primitive's inbound webhook timeout by sleeping 15 s in a handler and watching for a retry with the same `id`.
