// Pair a fresh browser with the agent that owns the paid job; saves storage state for tour shots.
import { readFile } from "node:fs/promises";
import { ORIGIN, go, launch } from "./recorder.mjs";
const code = (await readFile(".cache/pair-code", "utf8")).trim();
const s = await launch();
await go(s, `${ORIGIN}/app/pair`);
await s.page.waitForTimeout(1500);
const status = await s.page.evaluate(async (code) => (await fetch("/viewer/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) })).status, code);
await s.context.storageState({ path: ".cache/paired.json" });
console.log("pair status", status);
await s.browser.close();
