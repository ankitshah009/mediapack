"""Record the talk-sample fixture: real HTML slides in Chromium + synthesized narration.

Usage (from worker/, needs macOS `say`, ffmpeg, Playwright chromium):
    uv run python ../fixtures/record_talk_sample.py

Each slide's narration is synthesized with macOS `say`, its duration measured with
ffprobe, and the slide is held on screen in a Playwright video recording for exactly
that long (plus a short gap). Audio clips are concatenated with matching gaps and muxed.

Produces:
    fixtures/talk-sample.mp4            H.264 + AAC
    fixtures/talk-sample.timeline.json  per-slide start/end ms and the exact spoken text
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
SLIDES = HERE / "talk" / "slides.html"
OUT_MP4 = HERE / "talk-sample.mp4"
OUT_TIMELINE = HERE / "talk-sample.timeline.json"
FFMPEG = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
FFPROBE = shutil.which("ffprobe") or "/opt/homebrew/bin/ffprobe"
VOICE = "Samantha"
LEAD_MS = 1000  # silence before the first line
GAP_MS = 800  # silence after each line, slide still visible

NARRATION = [
    "Welcome everyone to the Agent Commerce Hackathon. This weekend you will build software "
    "that agents can discover, pay for, and use on their own.",
    "There are three tracks. Primitive plus Stripe covers agent payments and messaging. "
    "Manufact is for shipping an MCP server. And the overall winner gets a Y Combinator interview.",
    "The most important slide. Submissions are due Sunday at ten A M. You need a GitHub "
    "repository link and a two minute demo video. Late submissions will not be judged.",
    "Finally, logistics. The Wi-Fi network is hack guest, and the password is on your badge. "
    "Dinner is at seven P M on the second floor. Judging starts Sunday at eleven, and finalists "
    "present at two P M.",
]


def duration_ms(path: Path) -> int:
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        check=True, capture_output=True, text=True,
    ).stdout
    return int(float(out) * 1000)


def run() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="mp-talk-"))
    clips: list[tuple[Path, int]] = []
    for i, text in enumerate(NARRATION, 1):
        wav = tmp / f"line{i}.wav"
        subprocess.run(["say", "-v", VOICE, "-o", str(wav), "--data-format=LEI16@22050", text], check=True)
        clips.append((wav, duration_ms(wav)))

    # Planned schedule (ms from video start) — the audio is built to match it exactly.
    schedule = []
    t = LEAD_MS
    for i, ((_, d), text) in enumerate(zip(clips, NARRATION), 1):
        schedule.append({"slide": i, "speech_start_ms": t, "speech_end_ms": t + d, "text": text})
        t += d + GAP_MS
    total_ms = t + 1000

    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1280, "height": 720},
                                  record_video_dir=str(tmp), record_video_size={"width": 1280, "height": 720})
        t0 = time.monotonic()
        page = ctx.new_page()
        page.goto(SLIDES.as_uri())
        observed = []
        for item in schedule:
            # show slide N from the end of the previous line's gap (slide 1 from the start)
            start = 0 if item["slide"] == 1 else item["speech_start_ms"] - GAP_MS // 2
            while (time.monotonic() - t0) * 1000 < start:
                time.sleep(0.005)
            page.evaluate(f"go({item['slide']})")
            observed.append(int((time.monotonic() - t0) * 1000))
        while (time.monotonic() - t0) * 1000 < total_ms:
            time.sleep(0.01)
        video = page.video
        ctx.close()
        browser.close()
        webm = Path(video.path()) if video else None
    assert webm and webm.exists()

    # Audio track: lead silence, then each line followed by GAP_MS silence.
    inputs, filters = [], []
    for i, (wav, _) in enumerate(clips):
        inputs += ["-i", str(wav)]
        pad = LEAD_MS if i == 0 else 0
        filters.append(f"[{i + 1}:a]aresample=48000,adelay={pad}:all=1,apad=pad_dur={GAP_MS / 1000}[a{i}]")
    concat = "".join(f"[a{i}]" for i in range(len(clips)))
    fc = ";".join(filters) + f";{concat}concat=n={len(clips)}:v=0:a=1[aout]"
    subprocess.run(
        [FFMPEG, "-y", "-v", "error", "-i", str(webm), *inputs, "-filter_complex", fc,
         "-map", "0:v", "-map", "[aout]", "-c:v", "libx264", "-preset", "medium", "-crf", "23",
         "-pix_fmt", "yuv420p", "-r", "25", "-c:a", "aac", "-b:a", "128k", "-t", f"{total_ms / 1000}",
         "-movflags", "+faststart", str(OUT_MP4)],
        check=True,
    )
    for item, shown in zip(schedule, observed):
        item["slide_shown_ms"] = shown
    OUT_TIMELINE.write_text(json.dumps(
        {"video": OUT_MP4.name, "voice": VOICE, "duration_ms": total_ms, "slides": schedule}, indent=2) + "\n")
    shutil.rmtree(tmp, ignore_errors=True)
    for s in schedule:
        print(f"slide {s['slide']} shown {s['slide_shown_ms']/1000:6.2f}s  speech "
              f"{s['speech_start_ms']/1000:6.2f}-{s['speech_end_ms']/1000:6.2f}s")
    print(f"wrote {OUT_MP4}")


if __name__ == "__main__":
    run()
