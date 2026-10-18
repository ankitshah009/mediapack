Use MediaPack to inspect the provided video and answer the provided question with source evidence.

The operator must provide these values before starting:

- `MEDIAPACK_URL`: the real public HTTPS Next.js API URL hosted on Blaxel.
- A local MP4/WebM recording, at most 100 MiB and 180 seconds.
- An arbitrary question about visible actions or spoken content, without supplying the answer's timestamps.
- A private owner configuration path if the default CLI configuration is unsuitable.
- Explicit authorization for one USD 0.50 Stripe sandbox purchase and an authenticated sandbox buyer, if proceeding past the quote. A budget in this prompt does not configure a Link wallet approval policy.

Run from the repository root:

```sh
node scripts/mediapack.mjs --help
node scripts/e2e.mjs --help
node scripts/e2e.mjs --video "$MEDIAPACK_E2E_VIDEO" --query "$MEDIAPACK_E2E_QUERY"
```

This bootstraps a privately stored owner capability if necessary, uploads the operator's actual file, waits for server preflight, freezes the quote, and stops with `purchase_required`. Preserve the printed run directory. If and only if the sandbox purchase has been explicitly authorized, continue the same run:

```sh
node scripts/e2e.mjs --run-dir "$MEDIAPACK_E2E_RUN_DIR" --buy
```

Set `MEDIAPACK_E2E_RUN_DIR` to the actual directory printed by the first invocation. Preserve `MEDIAPACK_URL` and `MEDIAPACK_CONFIG` in the same terminal. Use `--via link` only with an installed/authenticated Link CLI and actual sandbox approval; the default buyer uses `MPPX_STRIPE_SECRET_KEY` from the terminal environment. Never paste a secret into command arguments, a report or the demo recording. The runner never purchases a replacement pack when allowance is exhausted and never bypasses a reconciling payment outcome.

For an existing owned job, use `--job JOB_UUID --query QUESTION`. The runner waits for real indexing, searches the question, selects the first valid returned match, retrieves up to two source frames and a clip of at most six seconds within that returned interval, and verifies downloaded artifact SHA-256 values. The interval comes from the source-grounded result, never from fixture timestamps. A no-match result is valid: report that the answer was not established from the indexed evidence and do not invent a clip or answer.

Open the downloaded MP4 in a real video player and confirm it plays and corresponds to the returned interval. Inspect frame contents. State what the evidence supports and the limitations of sampled visual indexing and transcription. Do not infer hidden causes, intent or identity from the recording. `evidence_verified` means downloaded bytes matched provider-recorded artifact hashes; playback still needs the actual player check.

The private run directory contains `state.json`, a redacted `run-manifest.json`, and downloaded artifacts. The manifest records actual source, job, payment, operation and artifact references. It excludes owner capabilities, SPTs and signed URLs. Do not publish the source recording or evidence unless the operator has authorized it. If required integration credentials, model access, Primitive delivery or Blaxel compute are unavailable, preserve the IDs, report the exact failed stage and resolve that dependency before resuming; never fabricate completion.

For the operator's dashboard, run `node scripts/mediapack.mjs pair`, open the printed `/app/pair` URL, and paste its one-time code. This pairs the browser to the CLI owner. Record only factual persisted activity and the actual Stripe sandbox receipt. To demonstrate input-dependent results, repeat with another fresh recording and the same question; show a different grounded interval or no match.
