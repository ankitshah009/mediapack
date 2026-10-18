// High-quality browser capture for the demo: CDP screencast frames (JPEG q92 at 1920x1080)
// assembled by ffmpeg into constant-30fps H.264, plus a visible synthetic cursor.
import { chromium } from "playwright";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export const ORIGIN = "https://mediapack-mediapack.preview.bl.run";
const CURSOR = `
(() => {
  const install = () => {
    if (document.getElementById("__demo_cursor")) return;
    const c = document.createElement("div");
    c.id = "__demo_cursor";
    c.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2l16 9.5-7.2 1.6L9 20z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, { position: "fixed", left: "0", top: "0", zIndex: 2147483647, pointerEvents: "none",
      transform: "translate(-100px,-100px)", transition: "transform 0s", filter: "drop-shadow(0 2px 3px rgba(0,0,0,.35))" });
    const ring = document.createElement("div");
    ring.id = "__demo_ring";
    Object.assign(ring.style, { position: "fixed", left: "0", top: "0", width: "34px", height: "34px", margin: "-17px 0 0 -17px",
      borderRadius: "50%", background: "rgba(212,242,90,.55)", zIndex: 2147483646, pointerEvents: "none", opacity: "0",
      transform: "translate(-100px,-100px) scale(.4)", transition: "opacity .35s, transform .35s" });
    document.documentElement.append(ring, c);
    addEventListener("mousemove", (e) => { c.style.transform = "translate(" + (e.clientX - 3) + "px," + (e.clientY - 2) + "px)"; }, true);
    addEventListener("mousedown", (e) => {
      ring.style.transition = "none"; ring.style.opacity = "1"; ring.style.transform = "translate(" + e.clientX + "px," + e.clientY + "px) scale(.4)";
      requestAnimationFrame(() => { ring.style.transition = "opacity .45s, transform .45s"; ring.style.opacity = "0"; ring.style.transform = "translate(" + e.clientX + "px," + e.clientY + "px) scale(1.6)"; });
    }, true);
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", install); else install();
})();`;

export async function launch({ storageState } = {}) {
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5, colorScheme: "light",
    ...(storageState ? { storageState } : {}),
  });
  await context.addInitScript(CURSOR);
  const page = await context.newPage();
  return { browser, context, page, mouse: { x: 640, y: 360 } };
}

/** Ease-in-out cursor travel, then optional click. */
export async function moveTo(s, target, { click = false, duration = 700 } = {}) {
  const loc = typeof target === "string" ? s.page.locator(target).first() : target;
  await loc.scrollIntoViewIfNeeded();
  const box = await loc.boundingBox();
  if (!box) throw new Error(`no box for ${target}`);
  const tx = box.x + box.width / 2, ty = box.y + box.height / 2;
  const steps = Math.max(12, Math.round(duration / 16));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    await s.page.mouse.move(s.mouse.x + (tx - s.mouse.x) * e, s.mouse.y + (ty - s.mouse.y) * e);
    await s.page.waitForTimeout(duration / steps);
  }
  s.mouse = { x: tx, y: ty };
  if (click) { await s.page.waitForTimeout(120); await s.page.mouse.down(); await s.page.mouse.up(); }
}

/** Smooth scroll by dy pixels over duration ms. */
export async function scrollBy(s, dy, duration = 1200) {
  await s.page.evaluate(([dy, duration]) => new Promise((done) => {
    const start = scrollY, t0 = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - t0) / duration), e = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
      scrollTo(0, start + dy * e);
      t < 1 ? requestAnimationFrame(tick) : done();
    };
    requestAnimationFrame(tick);
  }), [dy, duration]);
}

/** Start a screencast; returns stop() which writes `${name}.mp4` and returns its path. */
export async function record(s, outDir, name) {
  const dir = join(outDir, `${name}.frames`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const cdp = await s.context.newCDPSession(s.page);
  const frames = [];
  const pending = [];
  cdp.on("Page.screencastFrame", (f) => {
    const file = join(dir, `${String(frames.length).padStart(6, "0")}.jpg`);
    frames.push({ file, ts: f.metadata.timestamp });
    pending.push(writeFile(file, Buffer.from(f.data, "base64")));
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  const t0 = Date.now() / 1000;
  return async function stop() {
    const tEnd = Date.now() / 1000;
    await cdp.send("Page.stopScreencast").catch(() => {});
    await Promise.all(pending);
    if (!frames.length) throw new Error(`no frames captured for ${name}`);
    // Variable-rate frames -> concat list with real durations -> constant 30 fps.
    const lines = ["ffconcat version 1.0"];
    frames.forEach((f, i) => {
      const next = i + 1 < frames.length ? frames[i + 1].ts : tEnd - t0 + frames[0].ts;
      lines.push(`file '${f.file}'`, `duration ${Math.max(1 / 60, next - f.ts).toFixed(4)}`);
    });
    lines.push(`file '${frames[frames.length - 1].file}'`);
    const list = join(outDir, `${name}.ffconcat`);
    await writeFile(list, lines.join("\n"));
    const out = join(outDir, `${name}.mp4`);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-safe", "0", "-f", "concat", "-i", list,
      "-vf", "scale=1920:1080:flags=lanczos,fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "14", out]);
    await rm(dir, { recursive: true, force: true });
    await rm(list, { force: true });
    return out;
  };
}

/** Navigate with retries: the preview edge occasionally stalls a first request. */
export async function go(s, url) {
  for (let i = 1; ; i++) {
    try { return await s.page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 }); }
    catch (e) { if (i >= 4) throw e; console.error(`goto retry ${i}: ${url}`); }
  }
}
