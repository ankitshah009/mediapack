// Copies the canonical shared contracts into the worker so the Docker build context (worker/ only) is self-contained.
// Run after the lead changes apps/mediapack/src/contracts/index.ts. A test fails if the copies drift.
import { copyFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const src = fileURLToPath(new URL("../../apps/mediapack/src/contracts/index.ts", import.meta.url));
const dst = fileURLToPath(new URL("../src/contracts/index.ts", import.meta.url));
copyFileSync(src, dst);
console.log(`synced ${src} -> ${dst} (${readFileSync(dst).length} bytes)`);
