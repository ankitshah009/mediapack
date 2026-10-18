# MediaPack worker

The production worker is Node/TypeScript. It runs one validated `WorkRequest`,
downloads media through operation-scoped signed URLs, processes it with ffmpeg,
uploads immutable artifacts and replies to the inbound Primitive email with one
`WorkResult`. It never needs the database, Stripe or Supabase service-role key.

## Local setup and verification

Use Node 22.22.2 or newer and ffmpeg/ffprobe on `PATH` (`brew install ffmpeg` on
macOS). From this directory:

```sh
npm ci
npm run build
npm test
node dist/local.js probe_video ../fixtures/settings-reset.mp4 --out /tmp/mediapack-worker
node dist/local.js extract_frames ../fixtures/settings-reset.mp4 --ts 45139,47592 --out /tmp/mediapack-worker
node dist/local.js extract_clip ../fixtures/settings-reset.mp4 --start 40000 --end 52000 --out /tmp/mediapack-worker
```

These commands make no model or paid provider calls. The tests use real fixture
videos and ffmpeg; model calls use the real OpenAI SDK with a fake HTTP edge, and
transport tests use a loopback HTTP server and the built `dist/run.js` process.
The test environment must allow binding to `127.0.0.1`.

`index_video` uses local CPU Whisper for speech; vision and `search_video` use
the configured OpenAI-compatible endpoint. Local transcription requires
`whisper-cli` 1.9.5 and the pinned multilingual base model described below:

```sh
node dist/local.js index_video ../fixtures/settings-reset.mp4 --out /tmp/mediapack-worker
node dist/local.js search_video ../fixtures/settings-reset.mp4 --query 'When does the timeout return to 30?' --out /tmp/mediapack-worker
```

Search automatically reads the latest index from that output directory. Use
`--index /path/to/index.json` to choose another index. The source digest must
match. Every run writes artifacts and `work_result.json` under
`<out>/<video_id>/ops/<operation_id>/g<generation>/`.

## Production configuration

Build the image using the worker directory as the Docker context. The launcher
expects the built application in `/app` and runs `node dist/run.js`.

Each media worker requests **4096 MiB (4 GB)** in both the actual control-service
launch request and `worker/blaxel.toml`. This provides CPU/memory headroom for
ffmpeg and local Whisper transcription; the web host remains 2048 MiB. The
current immutable image is `sandbox/mediapack-worker:be53b19cc608a18554956`;
it contains the temporal-search fix, pinned CPU engine and multilingual base
weights. Earlier paid-flow/cloud checks used `b3457c6569418756b9492`; the final
SETTINGS search also passed through Manufact MCP on the new image.
See [cost estimates](../docs/blaxel-costs.md).

Configure these variables on the control service:

- `BLAXEL_WORKER_IMAGE`: the current immutable image reference above.
- `BL_WORKSPACE=mediapack` and `BL_CLIENT_CREDENTIALS`: the runtime service-account
  credential, retained only on the control server. The installed Blaxel SDK
  exchanges it for a short-lived OAuth token; the verified token lifetime is two
  hours. The launch region defaults to `us-pdx-1` and accepts `BL_REGION`.
- `PRIMITIVE_WORKER_API_KEY`: a dedicated worker credential allowed to reply to
  inbound work mail. The control service's Primitive credential is not forwarded.
- `OPENAI_BASE_URL=https://run.blaxel.ai/mediapack/models/sandbox-openai/v1`,
  `OPENAI_VISION_MODEL=gpt-4o-mini` and `OPENAI_SEARCH_MODEL=gpt-4o-mini`: the
  verified credited model gateway. The adapters use standard Bearer authorization
  and omit unsupported reasoning parameters for this model.
- `OPENAI_API_KEY` is optional on the control server. For `index_video` and
  `search_video`, the launcher authenticates through the SDK and supplies its
  short-lived gateway token as the worker's `OPENAI_API_KEY`. The HTTP client
  always receives a credential, but this deployment does not require a direct
  OpenAI model key.
  Probe/frame/clip actions receive no OpenAI configuration. Persistent Blaxel API
  keys are rejected as a source for gateway-token forwarding; the service-account
  secret never enters worker process environment or the manifest.
- Optional `OPENAI_IMAGE_DETAIL` and `OPENAI_REASONING_EFFORT`; reasoning effort
  applies only to supported reasoning models. `OPENAI_ASR_MODEL` does not select
  production ASR: audio always uses the local engine, without paid fallback.

For a local `dist/local.js` vision/search run, supply the same gateway URL and
model names with a short-lived token in `OPENAI_API_KEY`. Local CLI execution
does not invoke the control server's token-minting launcher. Native `bl login`
remains an operator authentication path, not automatic credential injection into
custom worker images.

The control service passes `MEDIAPACK_MANIFEST` as base64 JSON containing
`work_request`, `reply_email_id`, `worker_token` and `control_base_url`. A file
manifest may also be supplied with `node dist/run.js manifest.json`. Manifests
contain credentials: keep them out of logs and source control.

Each operation generation has its own named sandbox and process. Sandboxes expire
after 30 minutes; processes keep the sandbox alive while running and have a
600-second indexing limit or 120-second limit for other actions. Worker action
deadlines are shorter and cancel HTTP transfers, model calls and ffmpeg children.

The worker entry point exits `0` when a success **or failure** result was delivered,
`1` when result delivery failed, and `2` when no usable manifest identifiers exist.
Primitive replies reuse `mp:<operation_id>:result:<generation>` for safe retries.

Run `npm run sync-contracts` after changes to the canonical
`apps/mediapack/src/contracts/index.ts`; a test detects drift. The verified
provider boundaries and application checks are listed below.

## Local CPU transcription

The image contains [whisper.cpp 1.9.5](https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.5),
commit `d1be6fde11ac6e0407606b4e42fe72d34add8037`, built without GPU support.
The source archive SHA-256 is
`645445da884df6dbd52b30f82d7be7c01d1767c938714e477e786b88d529e9f4`.

The [multilingual base weights](https://huggingface.co/ggerganov/whisper.cpp/blob/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin)
are fixed to revision `5359861c739e955e79d9a303bcbc70fb988958b1`, SHA-256
`60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe`.
Docker verifies both downloads during the build, and the adapter verifies the
model before transcription. No engine/model download occurs during a job.

The runtime uses two CPU threads, one processor, GPU disabled and automatic
language detection. It reuses ffmpeg's mono 16 kHz, 16-bit PCM audio. WAV duration
comes from its data chunks, not a guessed header length; JSON segment offsets
are milliseconds and map exactly into the existing ASR seconds interface.
Transcription has a 300-second limit within the overall operation deadline;
cancellation kills the child and scratch files are removed. A missing or modified
model produces `TRANSCRIPTION_FAILED`, preserving `audio: failed` separately from
silent recordings (`audio: absent`). No transcript is printed in worker errors.

For local runs, set `WHISPER_CPP_BIN` (default `whisper-cli`) and
`WHISPER_MODEL_PATH` (image default `/opt/whisper/ggml-base.bin`) to the same
pinned engine and multilingual weights. To exercise the actual engine in tests:

```sh
WHISPER_TEST_MODEL_PATH=/path/to/ggml-base.bin npm test
```

Without that explicit path, real-model tests skip with an explanation; no test
downloads a model. The actual-engine test indexes `talk-sample.mp4`, checks the
spoken deadline's source interval and verifies cancellation and temporary-file
cleanup. Published memory estimates are about 388 MB for base; this is not a
measurement of whole-worker peak memory.

## Executed runtime checks (2026-10-18)

- A real 4 GB Blaxel sandbox transcribed 44.864 seconds of fixture audio in
  **7.618 seconds**, producing nine segments and locating the spoken deadline at
  21.32–26.40 seconds. It used the packaged local model without transcription
  API credentials. This smoke used image `ba57aed41dd0daabb4afe`; the current
  image retains the same ASR source/model pins. The temporary sandbox was deleted.
- Worker image `b3457c6569418756b9492` ran actual `gpt-4o-mini` gateway calls:
  strict-schema vision read a fixture deadline in **3.726 seconds**; search answered its day and
  time from that observation, citing the supplied record, in **1.878 seconds**.
  This sandbox exposed two CPUs and 4,131,266,560 bytes of visible memory; peak
  memory was not measured. Its temporary sandbox was deleted.
- Both real fixtures completed uploaded-source probing through Primitive work
  delivery, Blaxel execution, scoped signed artifact access and a Primitive reply,
  reaching persisted `ready` video state.
- The spoken TALK fixture completed the actual Stripe **test-mode** USD 0.50
  purchase, paid indexing, search and evidence delivery. Indexing produced 23
  frame records and nine speech records; search correctly answered Sunday at
  10 AM and the submission requirements. Two downloaded JPEGs and a six-second
  H.264/AAC clip passed SHA-256 checks; ffprobe and ffmpeg verified the playable
  clip. The existing paid pack was reused after a clip-launch failure, without a
  second purchase. The safe proof is `.blaxel/paid-talk-proof.json`.
- Temporal search now reviews the full chronological record list, including
  later field text and contradictions. A before/after match cites both states
  and may span nonconsecutive records. Three real gateway regressions used the
  actual persisted indices: both SETTINGS questions correctly compared the saved
  60-second timeout with the later 30-second value and cited the later frame;
  TALK still returned Sunday at 10 AM. No fixture timeline or expected answer was
  supplied to the model, and these standalone checks consumed no app allowance.
  Safe measurements and assertions are in `.blaxel/temporal-search-proof.json`.
- The final SETTINGS search passed through the actual Manufact MCP proxy, r6
  control service, Primitive and worker image `be53b19cc608a18554956`. It returned
  visible 30 seconds versus saved 60 seconds, with supported citations `f_0021`
  and `f_0024` spanning 40–48 seconds. This was the remaining paid-pack search;
  the prior index and purchase were reused. Citation-derived frames at 40 and 46
  seconds visibly show 60 with Saved, then 30. Both JPEGs and the eight-second
  40–48-second H.264 clip passed SHA-256 checks; the clip decoded without errors.
  All 15 final runtime checks passed, including one payment/entitlement/index,
  unchanged ledger on exact evidence replay, zero reservations and automatic
  reaping of the completed search sandbox during the normal frame launch.
  The safe proof is `.blaxel/paid-settings-proof.json`; the historical wrong
  search result remains preserved rather than rewritten.
- Worker typechecking and all **39 tests** passed, including real cached-model
  CPU Whisper, cancellation/cleanup, ffmpeg, chronological transition evidence
  and the loopback transport tests. The restricted environment initially denied
  loopback binding; all six transport tests passed on their authorized rerun.

Both fixture application flows are verified, including the final SETTINGS MCP
search, downloaded source-specific frames/playable clip and allowance ledger. See
[integration notes](../docs/integrations/primitive-blaxel.md) and
[verification](../docs/verification.md) for the overall application status.
