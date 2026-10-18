// Opt-in proof against a real deployed app. No fixture responses or merchant credentials are injected.
import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename, chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const QUERY = "What happens to the request timeout after it is saved and the page is reloaded? Give both values and cite the change.";
const BUDGET_MS = 8 * 60_000;
const secretValue = (v) => typeof v === "string" && (/^mp_[A-Za-z0-9_-]{32,}$/.test(v) || /[sr]k_(?:test|live)_[A-Za-z0-9]{16,}/.test(v));
const hasCredential = (v) => secretValue(v) || (v && typeof v === "object" && Object.values(v).some(hasCredential));

class ProofFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}
const requireProof = (ok, code) => { if (!ok) throw new ProofFailure(code); };

async function privateJson(path, value) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

async function renderedMedia(page, timeout = 30_000) {
  const images = page.locator('ul[aria-label="Delivered frames"] img');
  await images.first().waitFor({ timeout });
  await images.first().scrollIntoViewIfNeeded({ timeout });
  await page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll('ul[aria-label="Delivered frames"] img')];
    return imgs.length === 2 && imgs.every((i) => i.complete && i.naturalWidth === 1280 && i.naturalHeight === 800);
  }, undefined, { timeout });
  const source = page.locator('video[aria-label="Original uploaded video"]');
  await source.waitFor({ timeout });
  await page.waitForFunction(() => document.querySelector('video[aria-label="Original uploaded video"]')?.readyState >= 1, undefined, { timeout });
  await source.evaluate((v) => { v.currentTime = 42; });
  const clip = page.locator('video[aria-label^="Exported clip"]').first();
  await clip.waitFor({ timeout });
  await page.waitForFunction(() => document.querySelector('video[aria-label^="Exported clip"]')?.readyState >= 1, undefined, { timeout });
  await clip.evaluate((v) => { v.currentTime = 0.5; });
  await page.waitForFunction(() => [...document.querySelectorAll('video[aria-label="Original uploaded video"],video[aria-label^="Exported clip"]')].every((v) => v.readyState >= 2 && !v.seeking && !v.error), undefined, { timeout });
  return {
    frames: await images.evaluateAll((imgs) => imgs.map((i) => ({ complete: i.complete, width: i.naturalWidth, height: i.naturalHeight }))),
    clip: await clip.evaluate((v) => ({ readyState: v.readyState, duration: v.duration, width: v.videoWidth, height: v.videoHeight })),
  };
}

/** Read-only refresh of screenshots for the existing private proof. Never calls a purchase or operation route. */
export async function refreshDemoAgentScreenshots() {
  const directory = resolve(ROOT, ".blaxel");
  const proofPath = resolve(directory, "demo-buyer-proof.json");
  let browser;
  try {
    const proof = JSON.parse(await readFile(proofPath, "utf8"));
    requireProof(proof.status === "passed" && process.env.MEDIAPACK_URL && new URL(process.env.MEDIAPACK_URL).origin === proof.origin, "EXISTING_PASSED_PROOF_ORIGIN_REQUIRED");
    browser = await chromium.launch({ headless: true, channel: "chrome", timeout: 30_000 });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, storageState: resolve(directory, "demo-buyer-browser-state.json") });
    const page = await context.newPage();
    await page.goto(`${proof.origin}/app/jobs/${proof.job_id}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.getByText("Verified test payment", { exact: true }).waitFor({ timeout: 30_000 });
    proof.reloaded_media = await renderedMedia(page);
    for (const [name, viewport] of [["desktop", { width: 1280, height: 900 }], ["mobile", { width: 375, height: 900 }]]) {
      await page.setViewportSize(viewport);
      await renderedMedia(page);
      const geometry = await page.evaluate(() => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth }));
      requireProof(geometry.documentWidth <= geometry.viewport, "HORIZONTAL_OVERFLOW");
      proof[name] = geometry;
      const path = resolve(directory, `demo-buyer-ready-${name}.png`);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path, fullPage: true, timeout: 15_000 });
      await chmod(path, 0o600);
    }
    const r = await context.request.get(`${proof.origin}/v1/jobs/${proof.job_id}`, { timeout: 15_000 });
    requireProof(r.ok(), "READONLY_JOB_FAILED");
    const job = await r.json();
    requireProof(job.payment_intent_id === proof.payment_intent_id && JSON.stringify(job.used) === JSON.stringify(proof.used), "READONLY_USAGE_CHANGED");
    proof.readonly_screenshot_refresh = { passed: true, at: new Date().toISOString(), payment_and_usage_unchanged: true };
    await privateJson(proofPath, proof);
    console.log("PASS read-only screenshot refresh: media decoded, payment and usage unchanged");
    return 0;
  } catch {
    console.error("FAIL read-only screenshot refresh; no purchase or operation was attempted");
    return 1;
  } finally { await browser?.close().catch(() => {}); }
}

/** Runs only when explicitly opted in. Creates one fresh pack; never reads historical job IDs. */
export async function runDemoAgentProof() {
  if (process.env.RUN_DEMO_PAY !== "1") {
    console.error("Set RUN_DEMO_PAY=1 and MEDIAPACK_URL to explicitly run the fresh test-payment proof.");
    return 2;
  }
  let origin;
  try {
    const u = new URL(process.env.MEDIAPACK_URL ?? "");
    requireProof(u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash, "HTTPS_ORIGIN_REQUIRED");
    origin = u.origin;
  } catch {
    console.error("MEDIAPACK_URL must be the deployed HTTPS origin, without credentials or query parameters.");
    return 2;
  }

  const directory = resolve(ROOT, ".blaxel");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const proofPath = resolve(directory, "demo-buyer-proof.json");
  const statePath = resolve(directory, "demo-buyer-browser-state.json");
  const sourcePath = resolve(ROOT, "fixtures/settings-reset.mp4");
  const sourceHash = createHash("sha256").update(await readFile(sourcePath)).digest("hex");
  const started = Date.now();
  const proof = { status: "running", started_at: new Date().toISOString(), origin, fixture: "settings-reset.mp4", source_sha256: sourceHash, browser_state_file: statePath, timings_ms: {}, checks: {}, screenshots: [], artifact_downloads: [] };
  let browser, context, page, stage = "launch", deadlineReached = false, pageErrors = 0, credentialExposed = false;
  const responseChecks = new Set();
  const elapsed = () => Date.now() - started;
  const progress = () => console.log(`[demo-proof] ${stage} · ${Math.round(elapsed() / 1000)}s`);
  const heartbeat = setInterval(progress, 15_000);
  const watchdog = setTimeout(() => { deadlineReached = true; void browser?.close().catch(() => {}); }, BUDGET_MS);
  const budget = (ms) => Math.max(1, Math.min(ms, BUDGET_MS - elapsed()));
  const state = async () => { if (context) await privateJson(statePath, await context.storageState()); };
  const persist = async () => { proof.stage = stage; proof.elapsed_ms = elapsed(); await privateJson(proofPath, proof); };
  const step = async (name, fn) => {
    stage = name; progress(); const t = Date.now();
    const value = await fn(); proof.timings_ms[name] = Date.now() - t; await persist(); return value;
  };
  const get = async (path) => {
    const r = await context.request.get(origin + path, { timeout: budget(15_000) });
    requireProof(r.ok(), `APP_READ_HTTP_${r.status()}`);
    return r.json();
  };
  const job = () => get(`/v1/jobs/${proof.job_id}`);
  const poll = async (read, done, timeoutMs, code) => {
    const until = Date.now() + budget(timeoutMs);
    while (Date.now() < until) {
      const value = await read();
      if (done(value)) return value;
      requireProof(value?.state !== "failed" && value?.state !== "rejected", `${code}_FAILED`);
      await new Promise((r) => setTimeout(r, Math.min(2000, Math.max(1, until - Date.now()))));
    }
    throw new ProofFailure(`${code}_TIMEOUT`);
  };
  const screenshot = async (name) => {
    const path = resolve(directory, `demo-buyer-${name}.png`);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path, fullPage: true, timeout: budget(15_000) });
    await chmod(path, 0o600); proof.screenshots.push(path);
  };
  const extraction = async (kind) => poll(job, (j) => {
    const op = j.operations.find((o) => o.kind === kind);
    requireProof(op?.state !== "failed", `${kind.toUpperCase()}_FAILED`);
    return op?.state === "succeeded";
  }, 100_000, kind.toUpperCase());

  try {
    await persist();
    browser = await chromium.launch({ headless: true, channel: "chrome", timeout: budget(30_000) });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on("pageerror", () => { pageErrors++; });
    page.on("response", (r) => {
      const u = new URL(r.url());
      if (u.origin !== origin || !/^\/(?:viewer|v1)\//.test(u.pathname) || !r.headers()["content-type"]?.includes("json")) return;
      const task = r.json().then((body) => { if (hasCredential(body)) credentialExposed = true; }).catch(() => {}).finally(() => responseChecks.delete(task));
      responseChecks.add(task);
    });

    await step("fresh_browser_upload", async () => {
      await page.goto(origin + "/app", { waitUntil: "domcontentloaded", timeout: budget(30_000) });
      const me = await get("/viewer/me");
      requireProof(!me.authenticated && me.demo_buyer === true, "FRESH_DEMO_BROWSER_REQUIRED");
      proof.checks.fresh_browser = true;
      await page.locator("#video-file").setInputFiles(sourcePath);
      await page.waitForURL(/\/app\/v\/[0-9a-f-]{36}$/, { timeout: budget(75_000) });
      proof.video_id = new URL(page.url()).pathname.split("/").at(-1);
      const owner = await get("/viewer/me"); proof.client_id = owner.client_id;
      requireProof(owner.authenticated && typeof owner.client_id === "string", "UPLOAD_OWNER_MISSING");
      await state();
    });
    await step("server_media_verification", async () => {
      const video = await poll(() => get(`/v1/videos/${proof.video_id}`), (v) => v.state === "ready", 160_000, "MEDIA_VERIFICATION");
      requireProof(video.sha256 === sourceHash && video.width === 1280 && video.height === 800 && video.duration_ms >= 53_000 && video.duration_ms <= 54_000, "SOURCE_METADATA_MISMATCH");
      proof.checks.verified_source = true;
      await page.getByRole("heading", { name: "Verified metadata" }).waitFor({ timeout: budget(20_000) });
    });
    await step("quote", async () => {
      await page.getByRole("button", { name: "Get a quote", exact: true }).click();
      await page.waitForURL(/\/app\/jobs\/[0-9a-f-]{36}$/, { timeout: budget(30_000) });
      proof.job_id = new URL(page.url()).pathname.split("/").at(-1);
      console.log(`[demo-proof] job_id=${proof.job_id}`);
      const j = await job(); proof.quote_id = j.quote.quote_id;
      requireProof(j.video.video_id === proof.video_id && j.payment_state === "unpaid" && j.quote.payment_mode === "test" && j.quote.amount_minor === 50 && j.quote.currency === "usd", "TEST_QUOTE_REQUIRED");
      requireProof(Object.values(j.used).every((n) => n === 0), "FRESH_ALLOWANCE_REQUIRED");
      await page.getByRole("button", { name: /^Pay \$0\.50 with demo agent(?: \(test mode\))?$/ }).waitFor({ timeout: budget(20_000) });
      await state(); await screenshot("quote-desktop");
    });
    await step("ui_demo_payment", async () => {
      // The browser button is the authorization path. Do not substitute an API purchase here.
      await page.getByRole("button", { name: /^Pay \$0\.50 with demo agent(?: \(test mode\))?$/ }).click();
      const paid = await poll(job, (j) => j.payment_state === "paid", 95_000, "PAYMENT");
      requireProof(paid.quote.payment_mode === "test" && /^pi_/.test(paid.payment_intent_id ?? "") && paid.paid_at, "PERSISTED_PAYMENT_MISSING");
      const events = await get(`/v1/jobs/${proof.job_id}/events?after=0`);
      const verified = events.filter((e) => e.kind === "payment.verified");
      requireProof(verified.length === 1 && verified[0].details.livemode === false && verified[0].details.amount_minor === 50 && verified[0].details.payment_intent_id === paid.payment_intent_id, "PERSISTED_TEST_PAYMENT_EVENT_MISSING");
      proof.payment_intent_id = paid.payment_intent_id; proof.payment_event_id = verified[0].id; proof.checks.real_ui_payment = true;
      await state();
      await page.getByText("Verified test payment", { exact: true }).waitFor({ timeout: budget(20_000) });
    });
    await step("index_ready", async () => {
      const ready = await poll(job, (j) => j.state === "ready", 180_000, "INDEX");
      const indices = ready.operations.filter((o) => o.kind === "index_video");
      requireProof(indices.length === 1 && indices[0].state === "succeeded", "ONE_SUCCESSFUL_INDEX_REQUIRED");
      proof.index_operation_id = indices[0].operation_id;
      await page.locator("#q").waitFor({ timeout: budget(20_000) });
      proof.checks.index_ready = true;
    });
    await step("cited_settings_question", async () => {
      await page.locator("#q").fill(QUERY);
      await page.getByRole("button", { name: /^Search · uses 1 of / }).click();
      const searched = await poll(job, (j) => {
        const op = j.operations.find((o) => o.kind === "search_video");
        requireProof(op?.state !== "failed", "SEARCH_FAILED"); return op?.state === "succeeded";
      }, 120_000, "SEARCH");
      const op = searched.operations.find((o) => o.kind === "search_video"); const result = op.result;
      const cited = result.matches.filter((m) => m.evidence_status === "supported" && m.frame_refs?.length && m.start_ms < 48_000 && m.end_ms > 45_185);
      requireProof(/\b60\b/.test(result.answer) && /\b30\b/.test(result.answer) && /reload|refresh|revert|reset/i.test(result.answer) && cited.length > 0, "SAVED_60_RELOADED_30_CITATION_MISSING");
      proof.search_operation_id = op.operation_id; proof.answer = result.answer; proof.query = QUERY;
      proof.citations = cited.map(({ match_id, start_ms, end_ms, evidence_status }) => ({ match_id, start_ms, end_ms, evidence_status }));
      proof.checks.saved_60_reloaded_30_cited = true;
      await page.locator('ol[aria-label="Matches"] button[aria-pressed]').first().waitFor({ timeout: budget(20_000) });
      await page.locator('ol[aria-label="Matches"] button[aria-pressed]').first().click();
    });
    await step("source_frames", async () => {
      const video = page.locator('video[aria-label="Original uploaded video"]');
      await video.waitFor({ timeout: budget(20_000) });
      await poll(() => video.evaluate((v) => ({ readyState: v.readyState })), (v) => v.readyState >= 1, 20_000, "SOURCE_METADATA");
      for (const seconds of [42, 47]) {
        await video.evaluate((v, t) => { v.currentTime = t; }, seconds);
        await page.getByRole("button", { name: `Add 0:${seconds}`, exact: true }).click({ timeout: budget(15_000) });
      }
      await page.getByRole("button", { name: "Get 2 frames", exact: true }).click();
      const j = await extraction("extract_frames");
      proof.frames_operation_id = j.operations.find((o) => o.kind === "extract_frames").operation_id;
    });
    await step("source_clip", async () => {
      await page.getByLabel("Start", { exact: true }).fill("0:40");
      await page.getByLabel("End", { exact: true }).fill("0:48");
      await page.getByRole("button", { name: "Export clip", exact: true }).click();
      const j = await extraction("extract_clip");
      proof.clip_operation_id = j.operations.find((o) => o.kind === "extract_clip").operation_id;
    });
    await step("artifact_downloads_and_checksums", async () => {
      const j = await job();
      const artifacts = j.operations.filter((o) => ["extract_frames", "extract_clip"].includes(o.kind) && o.state === "succeeded").flatMap((o) => o.result.artifacts);
      requireProof(artifacts.filter((a) => a.kind === "frame").length === 2 && artifacts.filter((a) => a.kind === "clip").length === 1, "EXPECTED_EXPORTS_MISSING");
      const frames = artifacts.filter((a) => a.kind === "frame");
      const clip = artifacts.find((a) => a.kind === "clip");
      requireProof([42000, 47000].every((t) => frames.some((a) => a.requested_ms.start === t && Math.abs(a.actual_ms.start - t) <= 100)), "FRAME_TIMESTAMPS_MISMATCH");
      requireProof(clip.requested_ms.start === 40000 && clip.requested_ms.end === 48000 && Math.abs(clip.duration_ms - 8000) <= 50, "CLIP_TIMESTAMPS_MISMATCH");
      for (const a of artifacts) {
        const access = await get(`/v1/artifacts/${a.artifact_id}/access`);
        const r = await context.request.get(access.url, { timeout: budget(30_000) });
        requireProof(r.ok(), "ARTIFACT_DOWNLOAD_FAILED");
        const bytes = await r.body(); const hash = createHash("sha256").update(bytes).digest("hex");
        requireProof(hash === a.sha256 && a.source_sha256 === sourceHash && bytes.length > 0, "ARTIFACT_CHECKSUM_MISMATCH");
        requireProof(r.headers()["content-type"]?.split(";")[0] === a.content_type, "ARTIFACT_CONTENT_TYPE_MISMATCH");
        const path = resolve(directory, `demo-buyer-${a.kind}-${a.artifact_id}.${a.kind === "clip" ? "mp4" : "jpg"}`);
        await writeFile(path, bytes, { mode: 0o600 }); await chmod(path, 0o600);
        proof.artifact_downloads.push({ artifact_id: a.artifact_id, kind: a.kind, sha256: hash, source_sha256: a.source_sha256, bytes: bytes.length, content_type: a.content_type, actual_ms: a.actual_ms, requested_ms: a.requested_ms, path });
      }
      const delivered = page.locator('ul[aria-label="Delivered frames"] img');
      await delivered.first().scrollIntoViewIfNeeded({ timeout: budget(20_000) });
      proof.frame_images = await poll(() => delivered.evaluateAll((images) => images.map((i) => ({ complete: i.complete, width: i.naturalWidth, height: i.naturalHeight }))), (images) => images.length === 2 && images.every((i) => i.complete && i.width === 1280 && i.height === 800), 20_000, "FRAMES_VISIBLE");
      const exportedClip = page.locator('video[aria-label^="Exported clip"]').first();
      await exportedClip.scrollIntoViewIfNeeded({ timeout: budget(20_000) });
      await poll(() => exportedClip.evaluate((v) => ({ readyState: v.readyState })), (v) => v.readyState >= 1, 20_000, "CLIP_METADATA");
      await exportedClip.evaluate((v) => { v.currentTime = 0.5; });
      proof.clip_media = await poll(() => exportedClip.evaluate((v) => ({ readyState: v.readyState, duration: v.duration, width: v.videoWidth, height: v.videoHeight })), (v) => v.readyState >= 2 && v.duration >= 7 && v.duration <= 9 && v.width === 1280 && v.height === 800, 20_000, "CLIP_PLAYABLE");
      requireProof(j.used.searches === 1 && j.used.frames === 2 && j.used.clip_ms === Math.min(clip.duration_ms, 8000), "ALLOWANCE_COUNTER_MISMATCH");
      proof.used = j.used; proof.remaining = j.remaining; proof.checks.artifact_checksums_verified = true;
    });
    await step("same_quote_retry_and_reload", async () => {
      const before = await job();
      const retry = await page.evaluate(async (id) => {
        const r = await fetch(`/viewer/jobs/${id}/demo-purchase`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(90_000) });
        const j = await r.json();
        return { status: r.status, job_id: j.job_id, payment_state: j.payment_state, payment_intent_id: j.payment_intent_id };
      }, proof.job_id);
      const after = await job();
      requireProof(retry.status === 200 && retry.job_id === before.job_id && retry.payment_state === "paid" && retry.payment_intent_id === before.payment_intent_id && after.payment_intent_id === before.payment_intent_id, "SAME_QUOTE_PAYMENT_CHANGED");
      requireProof(JSON.stringify(before.used) === JSON.stringify(after.used) && JSON.stringify(before.reserved) === JSON.stringify(after.reserved) && before.operations.length === after.operations.length, "SAME_QUOTE_USAGE_CHANGED");
      proof.checks.same_quote_retry_preserves_payment_and_usage = true;
      await page.reload({ waitUntil: "domcontentloaded", timeout: budget(30_000) });
      await page.getByText("Verified test payment", { exact: true }).waitFor({ timeout: budget(20_000) });
      const reloaded = await job();
      requireProof(reloaded.payment_intent_id === before.payment_intent_id && reloaded.operations.filter((o) => o.kind === "index_video").length === 1, "RELOADED_PAYMENT_MISMATCH");
      proof.reloaded_media = await renderedMedia(page, budget(30_000));
      proof.operations = reloaded.operations.map(({ operation_id, kind, state }) => ({ operation_id, kind, state }));
      proof.events = (await get(`/v1/jobs/${proof.job_id}/events?after=0`)).map(({ id, kind, operation_id }) => ({ id, kind, operation_id }));
      await state(); proof.checks.paid_state_survives_reload = true;
    });
    await step("desktop_and_mobile", async () => {
      proof.desktop = await page.evaluate(() => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth }));
      await screenshot("ready-desktop");
      await page.setViewportSize({ width: 375, height: 900 });
      proof.mobile = await page.evaluate(() => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth }));
      requireProof(proof.desktop.documentWidth <= proof.desktop.viewport && proof.mobile.documentWidth <= proof.mobile.viewport, "HORIZONTAL_OVERFLOW");
      await screenshot("ready-mobile");
    });
    await Promise.all(responseChecks);
    const browserSecrets = await page.evaluate(() => ({ readableSessionCookie: document.cookie.includes("mp_session="), localValues: Object.values(localStorage), sessionValues: Object.values(sessionStorage) }));
    requireProof(!browserSecrets.readableSessionCookie && !hasCredential(browserSecrets.localValues) && !hasCredential(browserSecrets.sessionValues) && !credentialExposed, "SERVER_CREDENTIAL_EXPOSED_TO_BROWSER");
    requireProof(pageErrors === 0, "UNCAUGHT_PAGE_ERROR");
    proof.checks.server_capability_and_stripe_key_not_exposed = true;
    proof.status = "passed"; proof.completed_at = new Date().toISOString();
    console.log("PASS fresh browser demo payment, persisted index/search, cited exports, checksums, idempotency, and responsive layout");
    return 0;
  } catch (error) {
    proof.status = "failed";
    proof.failure = { stage, code: deadlineReached ? "OVERALL_8_MINUTE_DEADLINE" : error instanceof ProofFailure ? error.code : "BROWSER_OR_NETWORK_STEP_FAILED" };
    console.error(`FAIL demo proof: ${proof.failure.stage} (${proof.failure.code}); private state retained for inspection.`);
    return 1;
  } finally {
    clearInterval(heartbeat); clearTimeout(watchdog);
    await state().catch(() => {}); await persist();
    await browser?.close().catch(() => {});
  }
}
