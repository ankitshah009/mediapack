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

`index_video` and `search_video` local commands use the configured OpenAI account:

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
launch request and `worker/blaxel.toml`. This provides additional CPU/memory
headroom for ffmpeg and planned local Whisper transcription. The web host remains
2048 MiB. Memory allocation is a sandbox setting, so the existing verified worker
image can run at the new size without rebuilding it. Local Whisper is not yet
packaged or connected by this resource change. See [cost estimates](../docs/blaxel-costs.md).

Configure these variables on the control service:

- `BLAXEL_WORKER_IMAGE`: the built worker image reference.
- Authenticate locally with `bl login mediapack`; the SDK reads that session automatically.
  Explicit `BL_API_KEY` and `BL_WORKSPACE` are also supported, as are the Stripe Projects
  aliases `BLAXEL_PLAN_API_KEY` and `BLAXEL_PLAN_WORKSPACE`. The launch region defaults
  to `us-pdx-1` and accepts `BL_REGION`.
- `PRIMITIVE_WORKER_API_KEY`: a dedicated worker credential allowed to reply to
  inbound work mail. The control service's Primitive credential is not forwarded.
- `OPENAI_API_KEY`: needed for indexing and search.
- Optional `OPENAI_VISION_MODEL`, `OPENAI_SEARCH_MODEL`, `OPENAI_ASR_MODEL`,
  `OPENAI_REASONING_EFFORT` and `OPENAI_IMAGE_DETAIL`.

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
`apps/mediapack/src/contracts/index.ts`; a test detects drift. Live Blaxel,
Primitive, Supabase and model behavior still requires a configured provider smoke
test before deployment.
