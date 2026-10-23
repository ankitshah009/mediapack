# Primitive + Blaxel runtime integration

Current implementation and executed checks as of 2026-10-18. The active topology
is Next.js on Blaxel, a separate Node/ffmpeg/Whisper worker on Blaxel, and the MCP
proxy on Manufact. [Build decisions](../../DECISIONS.md) define the architecture;
[account setup](../SETUP-ACCOUNTS.md), [costs](../blaxel-costs.md) and
[verification](../verification.md) cover operator setup and the wider application.
The earlier Vercel/Python-agent/job proposal is superseded by this implementation.

## Implemented request/reply path

1. Control commits an operation and its outbox record in Postgres. The dispatcher
   sends the canonical `WorkRequest` JSON from the configured control address to
   the configured worker address through Primitive. Retries preserve the stored
   logical message and provider idempotency key.
2. One owned org-wide Primitive HTTP endpoint delivers mail to the Next.js
   `/webhooks/primitive` receiver. Control verifies the raw-body signature,
   durably records and deduplicates the provider event, matches the persisted
   request and claims the operation generation before launching compute.
3. The installed Blaxel SDK launches a named sandbox/process for that generation.
   The worker image runs `node dist/run.js` in `/app`; `keepAlive: true` prevents
   standby while the bounded process runs. The worker receives its operation
   manifest and scoped media token, not database, Stripe or Supabase service-role
   credentials.
4. The worker calls `POST /internal/operations/:id/artifact-access` with its scoped
   operation token to obtain signed source/index downloads and artifact uploads.
   Media bytes move directly through private Supabase Storage. Primitive carries
   JSON envelopes and artifact references, not the video or base64 images.
5. The worker replies to the inbound Primitive email ID using the official SDK.
   The body is a `WorkResult`; its stable idempotency key is
   `mp:<operation_id>:result:<generation>`. Primitive maintains the reply thread.
6. The reply returns to the same signed webhook. Control validates the active
   generation and action-specific result, verifies artifact ownership and source
   references, then commits the operation result and corresponding state/events.
   Superseded and repeated deliveries cannot overwrite a completed generation.

The subject identifies `[mp:<operation_id>:g<generation>] <action>`; the canonical
JSON body is authoritative. Provider delivery-event IDs, Primitive email IDs and
thread IDs remain distinct. A source preflight probe can finish before purchase;
paid indexing and retrieval require the separate entitlement checks.

## Runtime credentials

The control server uses `BL_WORKSPACE=mediapack` and the persistent service-account
`BL_CLIENT_CREDENTIALS`. That secret remains on the server. The installed
`@blaxel/core` SDK authenticates using client credentials and supplies a short-lived
OAuth token; the observed token lifetime is two hours.

For `index_video` and `search_video` launches, control authenticates through the
SDK and passes only its short-lived gateway token as the worker process's
`OPENAI_API_KEY`. Probe/frame/clip launches receive no OpenAI configuration. A
persistent Blaxel API key is rejected as a source for this token-forwarding path;
API-key authentication must not turn into forwarding the workspace key to a
worker. The service-account secret is never part of a worker manifest or process
environment.

A direct `OPENAI_API_KEY` is optional on control and is not required by the current
credited deployment. The worker's HTTP model client still receives a credential:
its `OPENAI_API_KEY` value is the short-lived Blaxel OAuth token supplied by the
launcher. This is explicit credential delivery, not automatic OpenAI API-key
injection into custom sandbox images. The mounted sandbox identity token was not
accepted as a general model-gateway credential and is not used for that purpose.

Primitive uses persistent runtime credentials for sending and replying, plus its
separate webhook signing secret. `PRIMITIVE_WORKER_API_KEY` is the configured
worker reply credential. Native CLI OAuth login is an operator session, not a
persistent server API key. Preserve private environment files and ownership
records; never log credentials, owner capabilities, signed URLs or provider
request bodies containing user media/text.

## Verified model gateway and local transcription

The existing `sandbox-openai` gateway is configured for `gpt-4o-mini`:

```text
OPENAI_BASE_URL=https://run.blaxel.ai/mediapack/models/sandbox-openai/v1
OPENAI_VISION_MODEL=gpt-4o-mini
OPENAI_SEARCH_MODEL=gpt-4o-mini
```

The worker uses the installed OpenAI SDK with standard
`Authorization: Bearer <short-lived token>`. No custom Blaxel authorization headers
are required on this verified gateway path. Vision and search use the Responses
API with strict JSON schemas. The worker omits unsupported reasoning parameters
for `gpt-4o-mini`, while preserving configured effort for supported reasoning
models and propagating operation cancellation to HTTP requests.

The gateway's audio-transcription route rejects requests. Production speech
processing instead uses the CPU-only, packaged whisper.cpp engine and pinned
multilingual base weights in the current image,
`sandbox/mediapack-worker:be53b19cc608a18554956`. It adds the temporal-search fix
to the earlier verified `b3457c6569418756b9492` image. The image verifies source/model
checksums during build, and the adapter verifies the model before transcription.
There is no first-job model download or automatic paid transcription fallback.

Whisper uses one processor and up to four CPU threads, GPU disabled and automatic language detection. Audio extract overlaps frame sampling. WAV
and JSON files stay inside operation scratch directories and are removed on
completion/failure. Transcription has a 300-second deadline within the overall
operation deadline. Missing/modified models produce actionable
`TRANSCRIPTION_FAILED` errors; `audio: failed` remains distinct from an absent
track (`audio: absent`). Exact engine/model revisions and checksums are in the
[worker README](../../worker/README.md#local-cpu-transcription).

## Sandbox lifecycle and hosting

Workers request 4096 MiB, have a 30-minute maximum sandbox lifetime, and use named
processes with `keepAlive: true`. The indexing process timeout is 600 seconds;
other actions have a 120-second timeout. Operation deadlines are shorter and
cancel model I/O and ffmpeg/Whisper child processes. Sandboxes are appropriate for
this implemented path because the actual process API supports `keepAlive` and
bounded timeouts; a public Agent endpoint or separate Batch Job is not required.

The Next.js host remains a separate 2048 MiB sandbox with `keepAlive: false`.
The current judging host uses a **24-hour idle deletion policy**; the hosting
helper defaults to one hour and accepts `--idle-ttl 24h`. Blaxel's idle timer is
based on resume/suspend events, not each HTTP request. Deletion removes its
preview URL. Recreating a host may require updating the owned Primitive endpoint and the Manufact API
origin. Only the owned endpoint should be changed; unrelated routing and signing
secrets must be preserved. See [hosting/cost details](../blaxel-costs.md).

The final deployment images are
`sandbox/mediapack-web:b355ba20b80085378c07c` for `mediapack-web-r7` and
`sandbox/mediapack-worker:be53b19cc608a18554956` for new worker operations.
The current [dashboard](https://b45bc8809f4a40e5dad83cb402719f89.preview.bl.run/app)
uses the 24-hour policy above.
The earlier paid TALK flow used worker image `b3457c6569418756b9492`; its
historical proof is preserved rather than attributed to the new image.

The worker image includes the Blaxel sandbox API executable so the SDK can use
its file/process interfaces. Runtime gateway access uses the explicit short-lived
token described above; merely having a model gateway in the workspace does not
make a credential appear inside a custom image.

## Executed checks

The following actual provider paths have passed:

- **Two source fixtures:** uploaded-source preflight operations traversed
  Primitive request delivery, Blaxel worker execution, scoped signed artifact
  access and Primitive result replies. Both videos reached persisted `ready`
  state. These were real provider deliveries, not locally signed empty fixtures.
- **Local ASR on Blaxel:** a real 4 GB sandbox transcribed 44.864 seconds of fixture
  audio in 7.618 seconds, producing nine segments and locating the spoken deadline
  at 21.32–26.40 seconds. The packaged local engine required no transcription
  API credential. That smoke used image `ba57aed41dd0daabb4afe`; the current
  `be53b19cc608a18554956` image retains the same ASR source/model pins. The temporary
  sandbox was deleted.
- **Actual vision and search:** the installed worker adapters made successful
  Responses calls through the real gateway, both locally and inside the verified
  worker image `b3457c6569418756b9492`. The cloud run read a frame deadline in
  3.726 seconds; search answered its day/hour from that provider-generated observation in 1.878 seconds,
  citing only the supplied record. Both strict-schema outputs and the source
  assertions passed. The temporary sandbox exposed two CPUs and 4,131,266,560 bytes
  of visible memory and was deleted afterward; this was not a peak-memory check.
- **TALK paid application flow:** the actual Stripe test-mode USD 0.50 purchase
  reached paid indexing through Primitive and Blaxel: 23 frames and nine speech
  records. Search correctly returned Sunday at 10 AM and the submission
  requirements. Two downloaded frames and a six-second H.264/AAC clip matched
  their stored SHA-256 digests; the clip decoded without errors. A clip-launch
  failure was recovered on the same paid pack, with no new purchase. Receipt
  idempotency and Primitive request/result records were verified. The safe proof
  is `.blaxel/paid-talk-proof.json`.
- **Temporal search regression:** search now reviews chronological states and
  later contradictions before answering. Transition matches cite both relevant
  states, even across nonconsecutive records; results retain chronological
  citation order. Three actual gateway calls used the persisted indices alone:
  both SETTINGS questions returned saved 60 seconds versus later 30 seconds and
  cited the later frame; TALK retained its Sunday 10 AM deadline answer. Fixture
  timelines and expected answers were assertion oracles only, never model input.
  These standalone adapter calls consumed no paid-pack search allowance. The safe
  proof is `.blaxel/temporal-search-proof.json`.
- **Final SETTINGS MCP search:** the actual Manufact proxy called r6 control,
  which delivered the operation through Primitive to worker image
  `be53b19cc608a18554956`. The answer correctly compared visible 30 seconds with
  saved 60 seconds. Supported citations `f_0021` and `f_0024` span 40–48 seconds.
  This used the paid pack's final search, reusing its existing index and purchase.
  Citation-derived frames at 40 and 46 seconds visibly show 60 with Saved, then
  30. Both full-resolution JPEGs and the eight-second H.264 clip passed SHA-256
  checks; ffmpeg decoded the complete clip without errors. All 15 final checks
  passed: the database still has one payment, entitlement and index; exact
  evidence replay leaves the ledger unchanged; all reservations are zero; and
  the normal frame launch automatically reaped the completed search sandbox.
  `.blaxel/paid-settings-proof.json` retains the final proof and historical wrong
  search answer. The earlier result was not rewritten or presented as correct.
- **Worker verification:** typechecking and all 39 tests passed, including the
  actual cached multilingual Whisper engine, real ffmpeg, cancellation/temporary
  cleanup and chronological transition evidence. The six loopback transport
  tests passed after rerunning with local socket access.

Safe, ignored proof artifacts retain source hashes, timings, usage and assertions;
they exclude tokens and provider text payloads. The combined model proof is
`.blaxel/model-runtime-proof.json` with mode `0600`.

Both fixtures completed Stripe test-mode purchase → paid indexing → search →
delivered frames/playable clip verification, including the final SETTINGS MCP
search and ledger checks on r6. Vision/search consume model-gateway usage;
local transcription consumes sandbox compute. Do not describe the whole index
as free of model usage or extrapolate one fixture's latency to every recording.

## Primary references

- [Primitive sending](https://docs.primitive.dev/docs/sending),
  [receiving](https://docs.primitive.dev/docs/receiving),
  [signature verification](https://docs.primitive.dev/docs/signature-verification)
  and [SDKs](https://docs.primitive.dev/docs/sdks).
- [Blaxel sandbox templates](https://docs.blaxel.ai/Sandboxes/Templates),
  [model queries](https://docs.blaxel.ai/Models/Query-a-model) and
  [OpenAI integration](https://docs.blaxel.ai/Integrations/OpenAI).
- [whisper.cpp 1.9.5](https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.5)
  and [pinned multilingual base weights](https://huggingface.co/ggerganov/whisper.cpp/blob/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin).
