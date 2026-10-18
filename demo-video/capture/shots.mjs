// Records the browser shots for the demo against the LIVE deployment (no local server).
//   node capture/shots.mjs upload            fresh browser session: upload -> server verification -> quote
//   node capture/shots.mjs tour <storage>    paired session on the completed paid job: answer, source, evidence, activity
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { ORIGIN, go, launch, moveTo, record, scrollBy } from "./recorder.mjs";

const OUT = resolve("public/footage");
const FIXTURE = resolve("../fixtures/settings-reset.mp4");
const JOB = process.env.DEMO_JOB_ID ?? "bb641bda-2ca7-492e-8e8f-303414e8ec7e";
await mkdir(OUT, { recursive: true });
const [shot, storage] = process.argv.slice(2);

async function upload() {
  const s = await launch();
  await go(s, `${ORIGIN}/app`);
  const stop = await record(s, OUT, "upload");
  await s.page.waitForTimeout(800);
  const start = s.page.getByRole("button", { name: /start new session/i });
  if (await start.count()) { await moveTo(s, start, { click: true }); await s.page.waitForTimeout(1500); }
  await moveTo(s, s.page.getByRole("button", { name: /choose video/i }));
  await s.page.waitForTimeout(400);
  await s.page.mouse.down(); await s.page.mouse.up();
  await s.page.locator('input[type="file"]').setInputFiles(FIXTURE);
  // Upload, then server-side ffprobe verification; the page moves to the video view.
  await s.page.waitForURL(/\/app\/v\//, { timeout: 60_000 }).catch(() => {});
  await s.page.getByText(/verified metadata/i).first().waitFor({ timeout: 180_000 });
  await s.page.waitForTimeout(1200);
  const quote = s.page.getByRole("button", { name: /quote/i }).first();
  await moveTo(s, quote, { click: true, duration: 900 });
  await s.page.waitForURL(/\/app\/jobs\//, { timeout: 60_000 });
  await s.page.waitForTimeout(2500);
  await scrollBy(s, 260, 1400);
  await s.page.waitForTimeout(2500);
  console.log("upload ->", await stop(), "job page", s.page.url());
  await s.context.storageState({ path: resolve(".cache/upload-session.json") });
  await s.browser.close();
}

async function tour() {
  if (!storage || !existsSync(storage)) throw new Error("pass the paired storage-state file");
  const s = await launch({ storageState: storage });

  // 1. Videos list -> open the paid job.
  await go(s, `${ORIGIN}/app`);
  let stop = await record(s, OUT, "videos");
  await s.page.waitForTimeout(1000);
  const row = s.page.locator("text=settings-reset.mp4").locator("xpath=ancestor::*[.//a][1]");
  await moveTo(s, row.getByText("Open job"), { click: true, duration: 1000 });
  await s.page.waitForURL(/\/app\/jobs\//);
  await s.page.getByText(/^Query$/i).first().waitFor({ timeout: 30_000 });
  await s.page.waitForTimeout(2500);
  console.log("videos ->", await stop());

  // 2. The answer: scroll past status banners to the query + cited match, select it so the player seeks.
  const query = s.page.getByText(/^Query$/i).first();
  await query.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 90));
  await s.page.waitForTimeout(600);
  stop = await record(s, OUT, "answer");
  await s.page.waitForTimeout(2200);
  const match = s.page.getByText("0:40–0:48").first();
  await moveTo(s, match, { duration: 900 });
  await s.page.waitForTimeout(500);
  await s.page.mouse.down(); await s.page.mouse.up();
  await s.page.waitForTimeout(1500);
  await scrollBy(s, 520, 1600);
  await s.page.waitForTimeout(800);
  const video = s.page.locator("video").first();
  await video.evaluate((v) => { v.muted = true; v.currentTime = 40; return v.play(); }).catch(() => {});
  await s.page.waitForTimeout(8500);
  await video.evaluate((v) => v.pause()).catch(() => {});
  console.log("answer ->", await stop());

  // 3. Evidence: exported frames and clips, one clip plays.
  const exported = s.page.getByText(/exported from this pack/i).first();
  await exported.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 70));
  await s.page.waitForTimeout(600);
  stop = await record(s, OUT, "evidence");
  await s.page.waitForTimeout(1800);
  await scrollBy(s, 420, 1500);
  const clip = s.page.locator('video[aria-label^="Exported clip"]').last();
  await moveTo(s, clip, { duration: 900 });
  await clip.evaluate((v) => { v.muted = true; v.currentTime = 0; return v.play(); }).catch(() => {});
  await s.page.waitForTimeout(8500);
  console.log("evidence ->", await stop());

  // 4. Activity steps + allowance + receipt (right rail).
  await s.page.evaluate(() => window.scrollTo(0, 0));
  await s.page.waitForTimeout(600);
  stop = await record(s, OUT, "activity");
  await s.page.waitForTimeout(1500);
  const act = s.page.getByText(/steps · \d+ persisted events/).first();
  await moveTo(s, act, { duration: 900 });
  await s.page.waitForTimeout(1200);
  await scrollBy(s, 700, 2600);
  await s.page.waitForTimeout(1000);
  await scrollBy(s, 900, 2600);
  await s.page.waitForTimeout(2500);
  console.log("activity ->", await stop());
  await s.browser.close();
}

async function limits() {
  const s = await launch({ storageState: storage });
  await go(s, `${ORIGIN}/app/jobs/${JOB}`);
  await s.page.getByText(/^Query$/i).first().waitFor({ timeout: 30_000 });
  const allowance = s.page.getByRole("heading", { name: /^Allowance$/ }).or(s.page.getByText(/^Allowance$/)).first();
  await allowance.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await s.page.waitForTimeout(800);
  const stop = await record(s, OUT, "limits");
  await s.page.waitForTimeout(3500);
  await s.page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await s.page.waitForTimeout(3500);
  console.log("limits ->", await stop());
  await s.browser.close();
}

// A real search on the paid talk pack, recorded while it runs: Primitive email -> Blaxel worker -> answer.
async function live() {
  const talkJob = process.env.TALK_JOB_ID ?? "d5df3fe7-5f75-4e56-87ed-bc1a0e7cbd7c";
  const question = process.env.QUESTION ?? "What are the hackathon tracks, and what does the overall winner get?";
  const s = await launch({ storageState: storage });
  await go(s, `${ORIGIN}/app/jobs/${talkJob}`);
  await s.page.getByText(/^Query$/i).first().waitFor({ timeout: 30_000 });
  await s.page.waitForTimeout(1500);
  const stop = await record(s, OUT, "live");
  await s.page.waitForTimeout(1500);
  const t0 = Date.now();
  const child = spawn("node", [resolve("../scripts/mediapack.mjs"), "search", talkJob, question, "--wait", "--timeout", "180"], {
    env: { ...process.env, MEDIAPACK_URL: ORIGIN, MEDIAPACK_CONFIG: process.env.CLIENT_CONFIG }, stdio: ["ignore", "pipe", "pipe"],
  });
  let out = ""; child.stdout.on("data", (d) => { out += d; });
  const code = await new Promise((done) => child.on("close", done));
  console.log("search exit", code, "in", ((Date.now() - t0) / 1000).toFixed(1), "s");
  await s.page.waitForTimeout(3500); // let the dashboard poll the committed result
  const match = s.page.locator("text=/^\\d+:\\d{2}–\\d+:\\d{2}$/").first();
  if (await match.count()) { await moveTo(s, match, { duration: 900 }); await s.page.mouse.down(); await s.page.mouse.up(); }
  await s.page.waitForTimeout(3500);
  console.log("live ->", await stop());
  try { const j = JSON.parse(out); const r = j.result ?? j.operation?.result ?? {}; console.log("ANSWER:", r.answer); console.log("MATCHES:", JSON.stringify((r.matches ?? []).map((m) => [m.start_ms, m.end_ms]))); }
  catch { console.log("raw:", out.slice(0, 600)); }
  await s.browser.close();
}

if (shot === "upload") await upload();
else if (shot === "live") await live();
else if (shot === "limits") await limits();
else if (shot === "tour") await tour();
else throw new Error("usage: shots.mjs upload | tour <storage-state.json>");
