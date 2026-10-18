// Neural voiceover with Kokoro-82M (kokoro-js, local, free). Writes public/audio/<id>.wav + src/timeline.json.
// Model: the int8 ONNX export from github.com/thewh1teagle/kokoro-onnx releases (Hugging Face's CDN is unreachable here),
// placed at .cache/models/onnx-community/Kokoro-82M-v1.0-ONNX/onnx/model_quantized.onnx with the HF config/tokenizer files.
import { env } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const VOICE = process.env.VOICE ?? "af_heart";
const SPEED = Number(process.env.SPEED ?? "1.22");
env.allowRemoteModels = false;
env.localModelPath = new URL("./.cache/models/", import.meta.url).pathname;

const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8", device: "cpu" });
// That export names its token input `tokens` (transformers.js sends `input_ids`) and its output `audio`.
const session = tts.model.sessions.model;
const run = session.run.bind(session);
const realIn = session.inputNames, realOut = session.outputNames;
let inner = false; // onnxruntime validates feeds against inputNames inside run(): report the real names there.
Object.defineProperty(session, "inputNames", { configurable: true, get: () => (inner ? realIn : ["input_ids", "style", "speed"]) });
Object.defineProperty(session, "outputNames", { configurable: true, get: () => (inner ? realOut : ["waveform"]) });
session.run = async (feeds, ...rest) => {
  inner = true;
  try {
    const out = await run({ tokens: feeds.input_ids, style: feeds.style, speed: feeds.speed }, ...rest);
    return { waveform: out[realOut[0]] };
  } finally { inner = false; }
};

const script = JSON.parse(await readFile("src/script.json", "utf8"));
const only = process.argv[2];
await mkdir("public/audio", { recursive: true });
const timeline = only ? JSON.parse(await readFile("src/timeline.json", "utf8")) : [];
for (const { id, text } of script) {
  if (only && id !== only) continue;
  const raw = `.cache/${id}.raw.wav`;
  // Long lines: generate sentence by sentence so prosody stays natural, then join with short pauses.
  const parts = text.match(/[^.!?:]+[.!?:]+["']?|[^.!?:]+$/g).map((p) => p.trim()).filter(Boolean);
  const files = [];
  for (const [i, part] of parts.entries()) {
    const audio = await tts.generate(part, { voice: VOICE, speed: SPEED });
    const f = `.cache/${id}.${i}.wav`;
    await audio.save(f);
    files.push(f);
  }
  const list = `.cache/${id}.concat.txt`;
  const pause = ".cache/pause.wav";
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", "0.12", pause]);
  await writeFile(list, files.flatMap((f, i) => [`file '${new URL(f, import.meta.url).pathname}'`, ...(i < files.length - 1 ? [`file '${new URL(pause, import.meta.url).pathname}'`] : [])]).join("\n"));
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", raw]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", raw, "-ar", "48000", "-ac", "2",
    "-af", "highpass=f=60,acompressor=threshold=-18dB:ratio=2.5:attack=8:release=120,loudnorm=I=-16:TP=-1.5:LRA=7", `public/audio/${id}.wav`]);
  const seconds = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", `public/audio/${id}.wav`]).toString());
  const entry = { id, seconds: Math.round(seconds * 100) / 100 };
  const k = timeline.findIndex((t) => t.id === id);
  if (k >= 0) timeline[k] = entry; else timeline.push(entry);
  console.log(id, entry.seconds);
}
await writeFile("src/timeline.json", JSON.stringify(timeline, null, 2) + "\n");
console.log("total", timeline.reduce((a, t) => a + t.seconds, 0).toFixed(1), "s");
process.exit(0); // onnxruntime-node can abort during teardown after all files are written
