"""Record the settings-reset bug fixture with a real Chromium session.

Usage (from worker/):
    uv run python ../fixtures/record_settings_reset.py

Produces:
    fixtures/settings-reset.mp4            H.264 recording of the session
    fixtures/settings-reset.timeline.json  wall-clock offsets (ms) of each scripted action,
                                           relative to the start of the video

The page (fixtures/bug-app/index.html) has a real persistence bug: Save writes
sessionStorage "gateway.requestTimeout" but load reads "gateway.request_timeout",
so after reload the Request timeout field shows the default 30 again.
"""

from __future__ import annotations

import functools
import http.server
import json
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

HERE = Path(__file__).resolve().parent
APP_DIR = HERE / "bug-app"
OUT_MP4 = HERE / "settings-reset.mp4"
OUT_TIMELINE = HERE / "settings-reset.timeline.json"
FFMPEG = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
SIZE = {"width": 1280, "height": 800}

# Draws a visible cursor + click ripple, since headless video has no OS cursor.
CURSOR_JS = """
window.addEventListener('DOMContentLoaded', () => {
  const c = document.createElement('div');
  c.style.cssText = 'position:fixed;left:0;top:0;width:18px;height:18px;margin:-2px 0 0 -2px;'
    + 'z-index:99999;pointer-events:none;border-radius:50% 50% 50% 0;transform:rotate(-45deg);'
    + 'background:rgba(20,26,38,.85);border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)';
  document.body.appendChild(c);
  const pos = JSON.parse(sessionStorage.getItem('__cursor') || '[640,400]');
  c.style.left = pos[0] + 'px'; c.style.top = pos[1] + 'px';
  document.addEventListener('mousemove', e => {
    c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px';
    sessionStorage.setItem('__cursor', JSON.stringify([e.clientX, e.clientY]));
  }, true);
  document.addEventListener('mousedown', e => {
    const r = document.createElement('div');
    r.style.cssText = `position:fixed;left:${e.clientX - 14}px;top:${e.clientY - 14}px;width:28px;height:28px;`
      + 'border-radius:50%;border:2px solid #2f6fec;z-index:99998;pointer-events:none;transition:all .35s;opacity:1';
    document.body.appendChild(r);
    requestAnimationFrame(() => { r.style.transform = 'scale(1.8)'; r.style.opacity = '0'; });
    setTimeout(() => r.remove(), 400);
  }, true);
});
"""


class Timeline:
    def __init__(self) -> None:
        self.t0 = time.monotonic()
        self.events: list[dict] = []

    def mark(self, name: str) -> None:
        t_ms = int((time.monotonic() - self.t0) * 1000)
        self.events.append({"t_ms": t_ms, "event": name})
        print(f"{t_ms / 1000:7.2f}s  {name}", flush=True)


def glide(page: Page, selector: str, *, click: bool = True, steps: int = 30) -> None:
    box = page.locator(selector).first.bounding_box()
    assert box, selector
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2, steps=steps)
    page.wait_for_timeout(250)
    if click:
        page.mouse.down()
        page.mouse.up()


def wander(page: Page, points: list[tuple[int, int]], pause_ms: int = 600) -> None:
    for x, y in points:
        page.mouse.move(x, y, steps=25)
        page.wait_for_timeout(pause_ms)


def serve(directory: Path) -> tuple[http.server.ThreadingHTTPServer, str]:
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(directory))
    handler.log_message = lambda *a, **k: None  # type: ignore[method-assign]
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}/index.html"


def run() -> None:
    srv, url = serve(APP_DIR)
    tmp = Path(tempfile.mkdtemp(prefix="mp-rec-"))
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport=SIZE, record_video_dir=str(tmp), record_video_size=SIZE)
        ctx.add_init_script(CURSOR_JS)
        tl = Timeline()  # video recording starts with the first page
        page = ctx.new_page()
        page.goto(url)
        tl.mark("open_general")
        wander(page, [(700, 300), (820, 260), (600, 360)], 900)

        # Browse General: change region and time zone
        glide(page, "#region")
        page.select_option("#region", "eu-west-1")
        tl.mark("general_region_changed")
        page.wait_for_timeout(1500)
        glide(page, "#tz")
        page.select_option("#tz", "Europe/Berlin")
        page.wait_for_timeout(2000)

        # Notifications
        glide(page, "nav a[data-tab=notifications]")
        tl.mark("open_notifications")
        page.wait_for_timeout(2000)
        glide(page, "#n-slack")
        page.wait_for_timeout(1200)
        glide(page, "#n-threshold")
        page.keyboard.press("Meta+A")
        page.keyboard.type("10", delay=180)
        page.wait_for_timeout(2500)

        # Activity log
        glide(page, "nav a[data-tab=activity]")
        tl.mark("open_activity")
        page.wait_for_timeout(1500)
        for sel in ["tbody tr:nth-child(4)", "tbody tr:nth-child(5)", "tbody tr:nth-child(8)"]:
            glide(page, sel, click=False)
            page.wait_for_timeout(1400)
        page.wait_for_timeout(2000)

        # Connection settings
        glide(page, "nav a[data-tab=connection]")
        tl.mark("open_connection")
        page.wait_for_timeout(2500)
        wander(page, [(760, 230), (760, 330)], 1000)
        glide(page, "#timeout")
        page.wait_for_timeout(800)
        page.keyboard.press("Meta+A")
        page.keyboard.type("60", delay=250)
        tl.mark("timeout_set_60")
        page.wait_for_timeout(2000)
        glide(page, "#save")
        tl.mark("save_clicked")
        page.wait_for_selector("#saved.show")
        tl.mark("saved_visible")
        page.wait_for_timeout(3500)
        wander(page, [(900, 140), (300, 30)], 800)

        tl.mark("reload")
        page.reload()
        page.wait_for_selector("#timeout")
        value = page.input_value("#timeout")
        tl.mark(f"after_reload_value_{value}")
        assert value == "30", f"bug not reproduced, got {value}"
        page.wait_for_timeout(1500)
        glide(page, "#timeout", click=False, steps=40)
        tl.mark("hover_timeout_30")
        page.wait_for_timeout(6000)
        tl.mark("end")

        video = page.video
        ctx.close()
        browser.close()
        webm = Path(video.path()) if video else None
    srv.shutdown()
    assert webm and webm.exists(), "no video recorded"

    subprocess.run(
        [FFMPEG, "-y", "-v", "error", "-i", str(webm), "-c:v", "libx264", "-preset", "medium",
         "-crf", "23", "-pix_fmt", "yuv420p", "-r", "25", "-movflags", "+faststart", str(OUT_MP4)],
        check=True,
    )
    OUT_TIMELINE.write_text(json.dumps({"video": OUT_MP4.name, "events": tl.events}, indent=2) + "\n")
    shutil.rmtree(tmp, ignore_errors=True)
    print(f"wrote {OUT_MP4} and {OUT_TIMELINE}")


if __name__ == "__main__":
    run()
