MediaPack implementation contracts
These are the application's contracts to implement, not copies of vendor SDK method signatures. Keep the wire shapes in one TypeScript/Zod package and reuse the same service functions from HTTP routes, MCP tools, CLI helpers, and the React viewer.
1. Fixed MVP product contract
One purchase activates one immutable uploaded video for 24 hours. The proposed demo price is USD 0.50, paid in Stripe sandbox mode. The pack includes indexing, three distinct searches, eight delivered source frames, fifteen seconds of delivered source clips, and 8,000 characters of evidence text. This is a demo product configuration, not a claim that the price covers every provider cost.
Input limits: 50 MiB, 180 seconds, maximum displayed dimensions 1920 by 1080. Accept MP4 or WebM with an actual decodable video stream. Audio is optional. Validate content with ffprobe; do not trust the filename, supplied MIME type, byte count, or duration. A 1080 by 1920 portrait video may be accepted by comparing long and short edges instead of a landscape-only width check; implement this explicitly.
The canonical source is a frozen object in a private Supabase bucket. Disable overwrites. A worker computes SHA-256 over the actual bytes before a quote becomes purchasable. Quote and job reference the same object and digest throughout the workflow.
Search matches are intervals supported by transcript segments, inspected frames, or both. A model can return no match. Observations do not imply a root cause, verified fix, identity verification, or any other specialized judgment.
2. Access model
Use a random 256-bit, expiring client capability for the MVP. Public POST /v1/clients creates a client and returns its capability once. Store only a peppered hash on the clients row. Each video belongs to that client; authorize jobs, operations, clips and frames through the full ownership relationship. The credential authorizes MediaPack access, not spending from a wallet.
- HTTP private endpoints require X-MediaPack-Token; this leaves Authorization available for the MPP payment credential.
- MCP uses Authorization: Bearer <client capability> in the configured transport. Do not pass capabilities as tool arguments or return them in widgets. The bootstrap CLI writes the credential to a private file with mode 0600 and configures the supported client's header without printing its value. A later OAuth integration may replace this mechanism without changing the domain services.
- A video ID, job ID, message ID, or client-supplied receipt is not authorization.
- The React bootstrap route creates the same client record and sets a same-origin, HttpOnly, Secure production session cookie without returning the capability to browser JavaScript. Validate Origin on cookie-authenticated mutations; use SameSite=Lax or stricter and explicit allowed origins. Do not put the capability in query parameters or localStorage.
- Worker tokens are separate short-lived signed credentials scoped to operation ID, attempt, lease generation, allowed artifact prefix, and expiry. They never authorize purchase or access to another operation.
- Provider credentials remain in backend processes. The worker receives model access, scoped media access and a dedicated Primitive worker credential able to send/reply as its configured address. Prefer an address-scoped credential after the actual send/reply smoke test. Keep the Supabase service role and merchant Stripe key out of the worker environment. Use a dedicated hackathon Primitive project if broader project credentials are required.
- Direct Storage access uses short-lived signed upload/download URLs for specific objects. Authorize every request that mints one. Refresh expired URLs through the API.
- Pair the human viewer to the CLI's client once: an authenticated client requests a random one-time pairing code; store its hash and a five-minute expiry, then consume it transactionally when creating the viewer cookie. Do not bootstrap a second owner when opening an existing agent's job.
- Limit client registration, upload creation and unpaid probing using persistent source/global counters and a small concurrency cap. A client can hold at most three unpaid uploads. Configure a total unpaid-storage cap and expire abandoned uploads after one hour. Creating another client credential must not bypass source/global caps.
This deliberately small capability design supports agents with HTTP and file-upload tools. Do not claim every chat host can upload local files or configure arbitrary HTTP headers. The CLI helper and React uploader provide explicit supported paths.
3. Public routes and MCP tools
Every mutation accepts a caller-generated request_id UUID. HTTP also uses Idempotency-Key where indicated. Save its canonical request hash; the same ID with a different request returns 409 IDEMPOTENCY_CONFLICT.
HTTP route    MCP tool    Behavior
GET /health    —    Readiness summary without secrets
GET /llms.txt    —    Service purpose, supported flow, limits, docs and MCP endpoint
POST /v1/clients    —    Rate-limited bootstrap; create expiring client credential for the CLI/HTTP caller
POST /v1/clients/viewer-code    —    Authenticated one-time code for pairing a browser to the same client
POST /viewer/session    —    Consume pairing code and set an HttpOnly same-origin cookie
POST /v1/videos    create_video    Create a client-owned video record and scoped upload instructions
POST /v1/videos/:video_id/complete    complete_upload    Check stored object; enqueue bounded preflight probe
GET /v1/videos/:video_id    get_video    Read upload/probe state and verified media metadata
POST /v1/videos/:video_id/quotes    quote_video    Freeze terms and pre-create the pending job after successful preflight
POST /v1/jobs/:job_id/purchase    —    Dedicated Stripe MPP endpoint; authorization plus quoted terms required
GET /v1/jobs/:job_id    get_job    Payment state, index state, operation states, allowance remaining and authorized artifact references
POST /v1/jobs/:job_id/searches    search_video    Reserve a query once and enqueue search over the stored multimodal index
POST /v1/jobs/:job_id/frames    get_frames    Retrieve or extract requested source frames within the same pack
POST /v1/jobs/:job_id/clips    get_clip    Retrieve or extract a source range within the clip allowance
GET /v1/jobs/:job_id/pack    get_pack    Read the accumulated manifest and receipt; does not generate new work
GET /v1/jobs/:job_id/events    —    Ordered event history for polling UI; no artificial timers
GET /v1/artifacts/:artifact_id/access    —    Authorize and mint a short-lived URL for an already entitled artifact
POST /webhooks/stripe    —    Raw-body signature verification, durable event receipt and payment reconciliation
POST /webhooks/primitive    —    Raw-body signature verification and durable inbox receipt
POST /internal/tick    —    Authenticated bounded outbox dispatch, stale-lease and payment reconciliation
POST /internal/operations/:id/artifact-access    —    Worker-scoped upload/download URL issuance


search_video, get_frames, and get_clip return 202 and an operation record while asynchronous work runs. The caller polls get_job; its operations list includes the existing operation's state and result. Cached completed operations can return 200 immediately. No result is successful before artifacts and source references are verified and committed.
MCP tools return structured status and a concise next action, with retry_after_seconds when pending. Use actual MCP image content for frames when supported, with captions and timestamps, plus artifact references as a portable fallback. Clip results return authorized references and a player in capable MCP App hosts. Keep large internal index blobs and base64 media out of ordinary text content.
Create and complete an upload
{
  "request_id": "<uuid>",
  "file_name": "product-walkthrough.mp4",
  "size_bytes": 31457280,
  "content_type": "video/mp4"
}
Creation returns video_id, upload instructions from the actual Storage API, and state: uploading. Implement Supabase signed resumable upload for files above 6 MB. The browser and CLI stream to Storage directly; do not route a 50 MiB file through the Manufact HTTP process or the LLM context. Never fabricate a TUS signed-token format: follow the current Storage SDK and resumable-upload documentation.
Completion uses the same video ID and authenticated client. It returns probing after the probe operation is durably queued. Probe checks actual size, SHA-256, media streams, display rotation, duration, and supported dimensions. Repeating completion returns the existing probe. Rejected media never becomes purchasable.
Quote result
{
  "schema_version": "mediapack.v1",
  "quote_id": "<uuid>",
  "job_id": "<uuid>",
  "video_id": "<uuid>",
  "source_sha256": "<sha256 of validated stored video>",
  "amount_minor": 50,
  "currency": "usd",
  "payment_mode": "test",
  "expires_at": "<UTC ISO timestamp>",
  "pack_ttl_seconds": 86400,
  "limits": {
    "searches": 3,
    "frames": 8,
    "clip_ms": 15000,
    "text_chars": 8000
  },
  "indexer_version": "video-index-v1",
  "terms_hash": "<canonical terms hash>",
  "purchase_url": "<configured origin>/v1/jobs/<job_id>/purchase"
}
The immutable terms hash includes schema version, video identity and content digest, verified input metadata, indexer version, amount/currency/mode, allowances, entitlement duration, and quote expiry. URLs that can expire are not the media identity. Resolve and authorize the stored quote for every purchase.
Search request and completed operation
{
  "request_id": "<uuid>",
  "query": "Where does the presenter export the report as a PDF?",
  "max_results": 3
}
{
  "operation_id": "<uuid>",
  "job_id": "<uuid>",
  "state": "succeeded",
  "query": "Where does the presenter export the report as a PDF?",
  "answer": "<summary supported by retrieved evidence>",
  "matches": [
    {
      "match_id": "<stable ID>",
      "start_ms": 100000,
      "end_ms": 112000,
      "description": "<observed event or spoken subject>",
      "modalities": ["visual", "speech"],
      "frame_refs": ["<internal frame ID>"],
      "transcript_refs": ["<segment ID>"],
      "transcript_excerpt": "<actual transcribed words>",
      "evidence_status": "supported"
    }
  ],
  "coverage": {
    "audio": "available",
    "visual_sample_interval_ms": 2000,
    "limitations": ["Brief events between sampled frames may be missed."]
  },
  "remaining": {"searches": 2, "frames": 8, "clip_ms": 15000, "text_chars": 7200}
}
The numeric timestamps and remaining text count above illustrate the schema. Derive all runtime values from the recording and ledger. Searching returns evidence references; it does not automatically deliver every referenced frame or render a clip. Fetching preview images counts toward the delivered-frame allowance. A source player can show an authorized original recording to its human owner; label that separately from an exported paid clip.
matches: [] with a supported explanation is a successful no-match result. Do not manufacture a match to satisfy the question. Report audio: absent for silent recordings and audio: failed with an error code for failed transcription; these are different conditions.
Frames and clips
{"request_id":"<uuid>","timestamps_ms":[102000,108000]}
{"request_id":"<uuid>","start_ms":100000,"end_ms":112000}
Return artifact IDs, source digest, requested and actual source ranges, output hashes, media type, dimensions/duration, and a short-lived authorized URL when materialized. Use integer milliseconds for persisted ranges; format mm:ss only in the UI. Persist actual video presentation timestamps. Normalize non-zero stream starts and preserve an explicit mapping back to original source time.
The frame endpoint returns the nearest valid decoded frame and its actual timestamp. The clip endpoint re-encodes accurately rather than relying on keyframe-only stream copying. Enforce allowance against the measured decoded clip duration, allowing only a documented one-frame measurement tolerance within the remaining budget. If necessary, trim down to the permitted duration before committing success.
4. Database records and constraints
Use Supabase Postgres migrations and SQL functions for transactions. Several consecutive Supabase client calls are not one transaction. Apply RLS to all application tables; expose data through the authorized server instead of public table access. Service-role credentials are server-only. Restrict execution privileges on privileged SQL functions.
Table    Essential fields and constraints
clients    UUID PK; unique capability hash; expiry; creation time; optional display name; revoked flag; one-time viewer-pair code hash/expiry. Display name is not a verified identity
videos    UUID PK; client FK; original filename; immutable bucket/object key UNIQUE; size; digest; duration/display dimensions; audio state; upload/probe state; timestamps/expiry
quotes    UUID PK; video FK; frozen price/mode/limits; indexer version; canonical terms hash; expiry. No mutation after issuance
jobs    UUID PK; quote FK UNIQUE; video FK; execution state; paid/expiry timestamps; consumed/reserved allowance totals; current index artifact; row version
payment_attempts    UUID PK; job FK; state; trusted terms hash; challenge fingerprint when available; Stripe PaymentIntent ID UNIQUE nullable; error classification; created/updated timestamps. Partial unique index permits at most one submitting, unknown or succeeded attempt per job
operations    UUID PK; job FK nullable for preflight; video FK; kind; request ID; canonical input hash; state; lease generation/token hash/expiry; sandbox/process IDs; reservation; committed result JSON; attempts. UNIQUE(video/job scope, kind, request_id)
artifacts    UUID PK; video/job/operation FKs; kind; immutable object key UNIQUE; digest; source start/end or frame timestamp; media metadata; delivered flag; indexer version
provider_events    Provider + event ID composite PK; event kind; minimal verified payload; received/applied timestamps; processing state. Store Primitive email ID and thread ID as separate fields
outbox    UUID PK; unique logical message key; operation ID; target/action; immutable payload JSON and hash; stable provider idempotency key; attempts; lease; next attempt; sent state/provider message ID
job_events    Increasing sequence/ID; job/video/operation IDs; factual event kind; safe display details; timestamp. No secrets, model thoughts or unverified progress


Keep a small durable rate-limit table or equivalent Postgres counters for anonymous uploads/probes. Its key is a verified request source plus the relevant capability; self-reported client names are not identities.
Client capabilities initially last 48 hours. At payment activation, ensure the client/session authorization horizon is no earlier than the newly purchased pack expiry; do not silently invalidate paid access. Pair codes, upload grants, quotes, source retention, artifact URLs and authorization have separate lifetimes. Check each explicitly.
Required SQL transaction helpers:
1. create_quote_and_job: verifies the frozen ready video, inserts immutable quote plus pending job once.
2. reserve_payment_attempt: atomically chooses one submitting attempt for an unpaid job.
3. apply_verified_payment: uniquely binds the verified PaymentIntent, marks entitlement active, and inserts one index_video operation and outbox event.
4. reserve_operation: validates entitlement, inserts or returns the idempotent operation, reserves remaining allowance, and writes its outbox message.
5. claim_outbox_batch: bounded FOR UPDATE SKIP LOCKED lease; no network I/O inside the DB transaction.
6. claim_operation: verifies the expected current generation and leases one actual execution.
7. complete_operation: accepts only the current lease, validates artifact ownership/ranges, commits results and budget use once, and appends one factual event.
8. fail_or_retry_operation: bounded retry with the same reservation; release reservation only when terminal and no result has been committed.
Database invariants matter more than the exact helper names. A superseded worker result cannot overwrite the active generation. Repeated get_job calls never write a new paid entitlement or reset counters.
5. Stripe purchase and recovery algorithm
Use the merchant's Stripe sandbox profile and SPT-only MPP for this MVP. Set the expected origin explicitly and use a stable server-side MPP challenge signing secret. Pin a current patched mppx release. Inspect installed types for exact Stripe metadata and receipt mapping; do not add guessed charge() options.
The purchase body is only {"quote_id":"<uuid>"}. Load video digest, amount, mode and limits from the server. Bind the challenge to the exact method/route, quote, job and terms using the verified SDK facilities. A newly issued challenge can have a new nonce; challenge ID is not the durable job ID.
Always run this application state gate before any SDK path that can charge:
1. Validate the client credential and video ownership, quote/job relationship, frozen source, requested body and idempotency key.
2. Already paid: return the same job and receipt reference; do not call Stripe again.
3. Submitting or unknown: return 202, payment_state: reconciling, and a status URL. Do not issue another 402 challenge or ask for a fresh token.
4. Unpaid with no payment credential: return the MPP challenge for the stored terms.
5. First valid credential-bearing attempt: atomically reserve a payment-attempt row before invoking the payment SDK.
6. Attach trusted job_id, quote_id, terms_hash, and attempt_id to the Stripe PaymentIntent at creation time, through the installed SDK's supported request-scoped options.
7. On success, retrieve/validate the actual PaymentIntent and call apply_verified_payment.
8. Timeout or ambiguous error after submission: keep the attempt unknown and reconcile it. A transport error does not prove a failed charge.
Use the same verified-payment transaction from the synchronous handler and a signature-verified payment_intent.succeeded webhook. Require matching status=succeeded, amount, currency, livemode=false, merchant environment and trusted metadata. A client-supplied receipt never unlocks work.
This recovers Stripe succeeded -> app crashed before DB commit: the webhook finds the pre-created job through PaymentIntent metadata and applies its one entitlement/outbox event. Duplicate webhooks are harmless. Never perform media work in a Stripe webhook before durably accepting the event.
Retrieve a known PaymentIntent ID directly. Metadata search is a recovery aid with eventual consistency; an empty search is not evidence that no payment occurred. A reservation made immediately before a process crash can remain reconciling until positively resolved. Show that state honestly. Do not loosen replay protection to force progress.
MPP rejects consumed/replayed SPTs. Do not treat replay protection as job-level idempotency, override the SDK's own Stripe idempotency key casually, or retry payment with a new SPT after an uncertain outcome. Buyer-side Link spend-request creation also needs its own persisted idempotency key and returned spend-request ID.
On terminal indexing failure, preserve the payment record and show failed plus a clear retry/recovery status. Implement a sandbox-only, idempotent refund recovery action as a later phase or clearly mark refund handling as manual. Do not display “refunded” until Stripe confirms it. Never silently buy another pack to retry an indexing failure.
6. Primitive transport contract
Use the installed @primitivedotdev/sdk or the documented REST API behind one adapter. The verified REST send path is POST /v1/send-mail; the reply path is POST /v1/emails/{inbound_email_id}/reply. REST uses body_text. SDK send examples use bodyText; its reply helper uses text. Do not mix these shapes.
Use two actual managed addresses, one for control and one for work. Preflight allowed recipients through GET /v1/send-permissions. Configure both routes to the service's webhook handler. The webhook's authenticated payload, intended recipient, expected sender and operation nonce determine whether to launch work or apply a result.
App-owned message envelope:
{
  "schema_version": "mediapack.v1",
  "kind": "work_request",
  "operation_id": "<uuid>",
  "job_id": "<uuid or null for probe>",
  "video_id": "<uuid>",
  "action": "index_video",
  "source_sha256": "<digest or null during preflight>",
  "terms_hash": "<hash or null during preflight>",
  "generation": 1,
  "media_ref": {"bucket":"mediapack-private","object_key":"<immutable key>"},
  "input": {},
  "reply_to_operation": "<uuid>"
}
Supported actions: probe_video, index_video, search_video, extract_frames, extract_clip. A result envelope uses kind: work_result, the same operation and generation, result/error status, and a compact manifest of verified artifact IDs and hashes. Payment credentials never enter Primitive messages.
Persist outgoing message JSON and its hash before sending. Use one explicit stable Idempotency-Key per logical message, such as mp:<operation_id>:request:<generation> and mp:<operation_id>:result:<generation>. Reuse both key and exact payload on transport retry. Primitive may return an earlier outcome when an explicit key is reused with changed content, so app-side payload hashing is mandatory.
Keyless multiple replies to an inbound message can be suppressed. Give acknowledgement, progress and result replies different explicit logical keys. Use the inbound email ID for reply threading; preserve thread IDs separately from provider event IDs. Do not confuse a delivery acknowledgement with completed media work.
Verify Primitive-Signature over the raw request bytes using the official verifier. Persist the stable Primitive event ID before returning 2xx; retries retain that ID. If persistence fails, return non-2xx so delivery can retry. Deduplication cannot be a check-then-insert race; use a unique database constraint.
MVP messages carry compact JSON and durable private artifact references. Mint expiring download URLs when the authorized worker or viewer accesses an artifact, so an old outbox payload does not embed an expired URL. Primitive's encrypted large-payload API is an optional adapter, not a dependency of this build.
7. Worker execution and budget accounting
Launch a real detached Blaxel process with waitForCompletion: false, keepAlive: true, a stable operation name, and a bounded process timeout. The documented waitForCompletion timeout by itself is not a compute kill switch. Record sandbox and process IDs before treating dispatch as complete, and reconcile ambiguous launches against the deterministic operation name.
Workers use a fixed runner command and a JSON manifest. Validate UUID-derived paths and use subprocess argument arrays for ffmpeg/ffprobe; never interpolate the user's question, filename or URLs into shell commands. The model produces schema-validated observations or rankings, never executable code.
Supabase owns leases, operations and allowance totals. Blaxel files are a cache and working directory. Write durable index/artifact objects before publishing the result. If a lease expires, reconcile the recorded process and attempt before starting a replacement. A generation fence prevents a late worker from applying stale results.
For each logical output operation, reserve allowance atomically before dispatch. Same request ID and same input returns the existing operation; changed input is a conflict. Cache repeated equivalent artifact requests by video digest + source range/timestamps + encoding parameters + indexer version. Re-reading an existing artifact consumes nothing new.
- Search count: count each distinct successfully executed question once; retries use the original operation. A no-match search consumes one query because it performed the search.
- Frames: count unique delivered full frames or crops. Internal indexing frames are a separate compute limit. A preview shown to the agent/viewer counts if it exposes a new paid frame.
- Clips: count the actual duration of each newly materialized unique clip. Overlapping but differently encoded/requested clips each consume their full duration; an exact cache hit does not. Enforce the total 15-second allowance transactionally.
- Text: count Unicode code points in newly committed evidence prose (answer, match descriptions and transcript excerpts). Exclude status fields and JSON keys. Replaying identical committed results does not count again. Bound generation and trim at sentence/segment boundaries before commit. Never label this as model token usage.
- Provider usage: separately record model tokens/calls, transcription seconds and worker runtime when returned by providers. These are not the caller's output allowance and do not constitute guaranteed dollar costs.
Allow one bounded retry per failed operation in the MVP. Preserve spent compute counters across retries. Release only uncommitted output reservations on a terminal failure. An expired or exhausted pack returns a structured error and an explicit next action; it never triggers a new purchase automatically.
8. Error response contract
{
  "error": {
    "code": "PAYMENT_RECONCILING",
    "message": "The purchase outcome is being checked.",
    "retryable": true,
    "retry_after_seconds": 5,
    "job_id": "<uuid>",
    "next_action": "get_job"
  }
}
Required codes: UNAUTHORIZED, UPLOAD_INCOMPLETE, MEDIA_UNSUPPORTED, INPUT_LIMIT_EXCEEDED, VIDEO_NOT_READY, QUOTE_EXPIRED, PAYMENT_REQUIRED, PAYMENT_RECONCILING, INDEX_NOT_READY, ALLOWANCE_EXCEEDED, IDEMPOTENCY_CONFLICT, MODEL_UNAVAILABLE, TRANSCRIPTION_FAILED, WORKER_FAILED, PACK_EXPIRED.
Never expose raw provider credentials, signed worker tokens, webhook secrets, arbitrary stack traces, or full unredacted payment responses through errors. Keep operational troubleshooting details in private logs indexed by operation ID.
