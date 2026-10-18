// Sentence start/end times (seconds into each voice line) from the per-sentence TTS files -> src/beats.json.
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const PAUSE = 0.12;
const script = JSON.parse(await readFile("src/script.json", "utf8"));
const beats = {};
for (const { id, text } of script) {
  const parts = text.match(/[^.!?:]+[.!?:]+["']?|[^.!?:]+$/g).map((p) => p.trim()).filter(Boolean);
  let t = 0;
  beats[id] = parts.map((p, i) => {
    const d = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", `.cache/${id}.${i}.wav`]).toString());
    const b = { text: p, start: Math.round(t * 100) / 100, end: Math.round((t + d) * 100) / 100 };
    t += d + PAUSE;
    return b;
  });
}
await writeFile("src/beats.json", JSON.stringify(beats, null, 1) + "\n");
for (const [id, list] of Object.entries(beats)) console.log(id, list.map((b) => `${b.start}:${b.text.slice(0, 22)}`).join(" | "));
