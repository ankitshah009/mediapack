// Local neural voiceover (Kokoro-82M via kokoro-js; no API, no cost). Writes audio/<id>.wav and src/timeline.json.
import { KokoroTTS } from "kokoro-js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const VOICE = process.env.VOICE ?? "af_heart";
const script = JSON.parse(await readFile("src/script.json", "utf8"));
await mkdir("audio", { recursive: true });
const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8", device: "cpu" });
const timeline = [];
for (const { id, text } of script) {
  const audio = await tts.generate(text, { voice: VOICE, speed: 1.0 });
  await audio.save(`audio/${id}.wav`);
  const seconds = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", `audio/${id}.wav`]).toString());
  timeline.push({ id, seconds: Math.round(seconds * 100) / 100 });
  console.log(id, seconds.toFixed(2));
}
await writeFile("src/timeline.json", JSON.stringify(timeline, null, 2) + "\n");
console.log("total", timeline.reduce((a, t) => a + t.seconds, 0).toFixed(1), "s");
