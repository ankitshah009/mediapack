# Submission

**Video (about 2 min):** `demo-video/out/mediapack-demo.mp4`. Product footage was captured from the live deployment at https://mediapack-mediapack.preview.bl.run:

- a real upload, verification and quote
- the paid jobs' cited answers, frames and clips
- a live search recorded while it ran

The email thread shown is real: it was fetched from Primitive's API.

**Repository:** https://github.com/ankitshah009/mediapack

**Live:** dashboard https://mediapack-mediapack.preview.bl.run/app · MCP https://fast-wave-awovc.run.mcp-use.com/mcp

**Two-sentence description**

> MediaPack lets AI agents buy evidence from a video: an agent pays $0.50 over Stripe's machine payment protocol (HTTP 402, test mode) and gets a 24-hour pack to ask questions about a recording, with answers that cite exact timestamps and come back as SHA-256-verified source frames and clips. Each video is indexed once by sandboxed Blaxel workers (ffmpeg, Whisper, vision) that exchange signed work orders and results with the API as a retrievable Primitive email thread, and Supabase Postgres enforces the pack's allowance, so the same paid pack works safely from the dashboard, the REST API, or an MCP server on Manufact.

## Rebuilding the video

```sh
cd demo-video
npm ci
npm run voice    # Kokoro-82M neural voice (local); writes public/audio/*.wav, src/timeline.json, src/beats.json
npm run bake     # footage segments at their on-screen speed, all-intra, 1x playback in Remotion
npm run render   # Remotion -> out/mediapack-demo.mp4
npm run images   # README architecture and job-flow images
```

- **Narration:** Kokoro-82M (`af_heart`), run locally through kokoro-js. The model file comes from the kokoro-onnx GitHub release, as noted in `tts.mjs`.
- **Music bed:** GarageBand's royalty-free "Afloat" Apple Loops.
- **Rendering browser:** use Remotion's own chrome-headless-shell, or set `REMOTION_BROWSER` to a chrome-headless-shell binary. Full Google Chrome in new-headless mode intermittently returned tiled, corrupted frames under parallel rendering.
- **Timing:** scene lengths follow the narration, and every visual beat is keyed to sentence start times in `src/beats.json`.
- **Your own voice:** record one WAV per line in `src/script.json`, save it as `public/audio/<id>.wav`, update `src/timeline.json` and `src/beats.json`, then render.
