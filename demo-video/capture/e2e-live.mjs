// End-to-end browser test against the LIVE deployment, from a fresh profile (what a judge sees).
// Run from demo-video/:  PAIR_CODE=$(node ../scripts/mediapack.mjs pair | jq -r .code) npm run e2e:live
// Uses one frame from the paid talk pack (section D). Exits non-zero on any failure.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const O = "https://mediapack-mediapack.preview.bl.run";
const SETTINGS_JOB = "bb641bda-2ca7-492e-8e8f-303414e8ec7e";
const TALK_JOB = "d5df3fe7-5f75-4e56-87ed-bc1a0e7cbd7c";
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const go = async (page, url) => { for (let i = 0; i < 4; i++) { try { return await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 }); } catch (e) { if (i === 3) throw e; } } };

const browser = await chromium.launch({ headless: true, channel: "chrome" });
const pageErrors = [];
const mk = async (opts = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...opts });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(`${page.url()} :: ${e.message}`));
  return { ctx, page };
};

try {
  // ── A. Fresh visitor: home, preflight rejection, upload with NO session (the reported bug), verification, quote
  {
    const { ctx, page } = await mk();
    await go(page, `${O}/app`);
    await page.getByText("Upload a video to search").waitFor({ timeout: 20000 });
    check("A1 home loads", true);
    check("A2 test-mode badge visible", await page.getByText(/Stripe test mode/i).first().isVisible());

    await page.locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not a video") });
    const pre = await page.getByText(/Unsupported type/i).first().waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
    check("A3 non-video file rejected before upload", pre);

    const t0 = Date.now();
    await page.locator('input[type="file"]').setInputFiles(resolve("../fixtures/settings-reset.mp4"));
    const navigated = await page.waitForURL(/\/app\/v\//, { timeout: 60000 }).then(() => true).catch(() => false);
    const failText = await page.getByText(/Upload failed|Missing or invalid credentials/i).first().isVisible().catch(() => false);
    check("A4 upload without a session auto-starts one", navigated && !failText, failText ? "credential error shown" : `${((Date.now() - t0) / 1000).toFixed(1)} s to video page`);
    const verified = await page.getByText(/Verified metadata/i).first().waitFor({ timeout: 180000 }).then(() => true).catch(() => false);
    check("A5 server verification completes (ffprobe on a Blaxel worker)", verified, `${((Date.now() - t0) / 1000).toFixed(1)} s total`);
    const meta = await page.locator("body").innerText();
    check("A6 verified metadata is real", /0:53/.test(meta) && /1280×800/.test(meta), "0:53 · 1280×800 expected");

    await page.getByRole("button", { name: /quote/i }).first().click();
    const onJob = await page.waitForURL(/\/app\/jobs\//, { timeout: 60000 }).then(() => true).catch(() => false);
    check("A7 quote creates a job page", onJob);
    await page.getByText("$0.50").first().waitFor({ timeout: 30000 }).catch(() => {});
    await page.getByText(/Verify media/).first().waitFor({ timeout: 30000 }).catch(() => {});
    const jobText = await page.locator("body").innerText();
    check("A8 quote shows $0.50 + 402 buy instructions", /\$0\.50/.test(jobText) && /mediapack\.mjs buy/.test(jobText));
    check("A9 activity shows Upload → Verify media → Purchase steps", /Upload/.test(jobText) && /Verify media/.test(jobText) && /Purchase/.test(jobText));

    await go(page, `${O}/app`);
    await page.waitForTimeout(2500);
    const listed = (await page.locator("body").innerText()).includes("settings-reset.mp4");
    check("A10 uploaded video appears in this browser's list", listed);
    await ctx.close();
  }

  // ── B. Pairing: wrong code rejected, real code shows the agent's paid videos
  {
    const { ctx, page } = await mk();
    await go(page, `${O}/app/pair`);
    await page.locator("#pair-code").fill("definitely-not-a-valid-code");
    await page.locator("form button[type=submit]").click();
    const bad = await page.getByText(/invalid|expired|not found|could not/i).first().waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
    check("B1 invalid pairing code shows an error", bad);
    const code = (process.env.PAIR_CODE ?? readFileSync(".cache/pair-code", "utf8")).trim();
    await page.locator("#pair-code").fill(code);
    await page.locator("form button[type=submit]").click();
    await page.waitForTimeout(3500);
    await go(page, `${O}/app`);
    const paired = await page.getByText("talk-sample.mp4").first().waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
    check("B2 valid pairing code shows the agent's videos", paired);

    // ── C. Paid job: cited answer, source seek, frames, clips, receipt, allowance, activity, raw events, exhausted search
    await go(page, `${O}/app/jobs/${SETTINGS_JOB}`);
    await page.getByText(/^Query$/i).first().waitFor({ timeout: 30000 });
    const body = await page.locator("body").innerText();
    check("C1 cited answer with 0:40–0:48", body.includes("0:40–0:48"));
    await page.locator("button[aria-pressed]").filter({ hasText: "0:40–0:48" }).first().click();
    await page.locator('video[aria-label="Original uploaded video"]').waitFor({ timeout: 20000 });
    await page.waitForTimeout(2500);
    const t = await page.locator('video[aria-label="Original uploaded video"]').evaluate((v) => v.currentTime).catch(() => -1);
    check("C2 clicking the citation seeks the source", t >= 39 && t <= 49, `currentTime=${t.toFixed?.(1)}`);
    const frames = await page.$$eval("img", (els) => els.filter((e) => /0:3|0:4/.test(e.alt ?? "") || (e.closest("figure") !== null)).map((e) => e.complete && e.naturalWidth > 0));
    const frameImgs = await page.$$eval("img", (els) => els.filter((e) => e.naturalWidth > 200).length);
    check("C3 exported frames load", frameImgs >= 4, `${frameImgs} images loaded`);
    await page.waitForTimeout(2000);
    const clips = await page.$$eval('video[aria-label^="Exported clip"]', (vs) => vs.map((v) => ({ rs: v.readyState, d: Math.round(v.duration) })));
    check("C4 exported clips load metadata", clips.length === 2 && clips.every((c) => c.rs >= 1 && c.d >= 5), JSON.stringify(clips));
    check("C5 receipt shows verified test payment", /Verified test payment/.test(body) && /\$0\.50/.test(body));
    check("C6 allowance meters render", /3 \/ 3/.test(body) && /14 \/ 15s/.test(body));
    const steps = /(\d+) steps · (\d+) persisted events/.exec(body);
    check("C7 activity grouped into steps", !!steps && Number(steps[1]) >= 10, steps?.[0] ?? "missing");
    await page.getByRole("button", { name: /Show raw events/ }).click();
    const raw = await page.getByText(/Times are runtime offsets/).first().isVisible();
    await page.getByRole("button", { name: /Show steps/ }).click();
    check("C8 raw-events toggle works both ways", raw && (await page.getByText(/steps · \d+ persisted events/).first().isVisible()));
    check("C9 exhausted search pack is explained", /Search allowance used up/.test(body));
    check("C10 no [object Object] anywhere", !/\[object Object\]/.test(body));

    // ── D. Real extraction on the live system: one frame from the paid talk pack (Primitive → Blaxel worker → Storage)
    await go(page, `${O}/app/jobs/${TALK_JOB}`);
    await page.getByText(/^Query$/i).first().waitFor({ timeout: 30000 });
    const before = (/Exported frames\s*(\d+)/.exec(await page.locator("body").innerText()) ?? [])[1];
    const v = page.locator('video[aria-label="Original uploaded video"]');
    await v.evaluate((el) => { el.currentTime = 12; });
    await page.locator("button", { hasText: "Add 0:12" }).first().waitFor({ timeout: 15000 });
    await page.locator("button", { hasText: "Add 0:12" }).first().click();
    await page.locator("button", { hasText: /^Get 1 frame$/ }).first().click();
    const t1 = Date.now();
    let after = before;
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(2000);
      after = (/Exported frames\s*(\d+)/.exec(await page.locator("body").innerText()) ?? [])[1];
      if (after && after !== before) break;
    }
    check("D1 frame extraction completes end to end", !!after && after !== before, `exported frames ${before ?? 0} → ${after ?? "?"} in ${((Date.now() - t1) / 1000).toFixed(1)} s`);
    await ctx.close();
  }

  // ── E. Mobile layout (390px): no horizontal scroll on home and a job page
  {
    const { ctx, page } = await mk({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await go(page, `${O}/app`);
    await page.waitForTimeout(2500);
    const overflowHome = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    check("E1 mobile home has no horizontal scroll", overflowHome <= 1, `overflow ${overflowHome}px`);
    await page.locator('input[type="file"]').setInputFiles(resolve("../fixtures/talk-sample.mp4"));
    const mNav = await page.waitForURL(/\/app\/v\//, { timeout: 60000 }).then(() => true).catch(() => false);
    const mVer = mNav && await page.getByText(/Verified metadata/i).first().waitFor({ timeout: 180000 }).then(() => true).catch(() => false);
    const overflowVideo = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    check("E2 mobile upload + verification works (speech video)", mVer, `overflow ${overflowVideo}px`);
    await ctx.close();
  }
} catch (e) {
  check("runner", false, e.message.split("\n")[0]);
} finally {
  check("Z1 no uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}
