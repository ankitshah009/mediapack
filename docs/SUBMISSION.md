# Submission

**Video (≤ 2 min):** `demo-video/out/mediapack-demo.mp4`. Rebuild it with `cd demo-video && npm run render` (Remotion). All product footage was captured from the live deployment at https://mediapack-mediapack.preview.bl.run.

**Repository:** https://github.com/ankitshah009/mediapack

**Live:** dashboard https://mediapack-mediapack.preview.bl.run/app · MCP https://fast-wave-awovc.run.mcp-use.com/mcp

**Two-sentence description**

> MediaPack lets AI agents buy evidence from a video: an agent pays $0.50 over Stripe's machine payment protocol (HTTP 402, test mode) and gets a 24-hour pack to ask questions about a recording, with answers that cite exact timestamps and come back as SHA-256-verified source frames and clips. Each video is indexed once by sandboxed Blaxel workers (ffmpeg, Whisper, vision) that receive work over Primitive, and Supabase Postgres enforces the pack's allowance, so the same paid pack works safely from the dashboard, the REST API, or an MCP server on Manufact.

## Re-voicing the video

The draft narration uses the built-in macOS voice. To swap in your own voice:

1. Record one WAV per line in `demo-video/src/script.json`.
2. Save each file as `demo-video/public/audio/<id>.wav`.
3. Update `demo-video/src/timeline.json` with the new durations (ffprobe).
4. Run `npm run render`. Each scene's length follows its narration line.
