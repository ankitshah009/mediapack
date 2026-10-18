// Draft voiceover with the built-in macOS voice (no download, no cost). Writes audio/<id>.wav + src/timeline.json.
// Replace with a human recording later: same ids, same file names.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const VOICE = process.env.VOICE ?? "Samantha (English (US))";
const RATE = process.env.RATE ?? "182";
const script = JSON.parse(await readFile("src/script.json", "utf8"));
await mkdir("public/audio", { recursive: true });
const timeline = [];
for (const { id, text } of script) {
  execFileSync("say", ["-v", VOICE, "-r", RATE, "-o", `public/audio/${id}.aiff`, text]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", `public/audio/${id}.aiff`, "-ar", "48000", "-ac", "2",
    "-af", "highpass=f=70,acompressor=threshold=-20dB:ratio=3:attack=5:release=80,loudnorm=I=-16:TP=-1.5:LRA=7", `public/audio/${id}.wav`]);
  const seconds = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", `public/audio/${id}.wav`]).toString());
  timeline.push({ id, seconds: Math.round(seconds * 100) / 100 });
}
await writeFile("src/timeline.json", JSON.stringify(timeline, null, 2) + "\n");
console.log(timeline.map((t) => `${t.id} ${t.seconds}`).join("\n"), "\ntotal", timeline.reduce((a, t) => a + t.seconds, 0).toFixed(1));
