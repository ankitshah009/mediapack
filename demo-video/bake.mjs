// Bake each footage segment at the exact speed/trim a scene shows it, as all-intra H.264 at 30 fps.
// Remotion then plays every clip at 1x: no high-rate seeking through long GOPs (which produced tiled,
// mis-strided frames under parallel rendering). Writes public/footage/baked/*.mp4 and src/baked.json.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const FPS = 30, VO_DELAY = 4;
const beats = JSON.parse(await readFile("src/beats.json", "utf8"));
const timeline = JSON.parse(await readFile("src/timeline.json", "utf8"));
const pads = JSON.parse(await readFile("src/pads.json", "utf8"));
const at = (id, i, plus = 0) => VO_DELAY + Math.round((beats[id][i].start + plus) * FPS);
const frames = (id) => { const t = timeline.find((x) => x.id === id); return VO_DELAY + Math.ceil(t.seconds * FPS) + (pads[id] ?? pads.default); };
const dur = (src) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", `public/footage/${src}`]).toString());

// Each entry: what the scene shows and for how many frames. rate = source seconds per output second.
const payA = at("pay", 2) - 4, bugA = at("bug", 2) - 4, bugB = frames("bug") - at("bug", 2) - 4;
const SEGMENTS = {
  payUpload: { src: "upload.mp4", trim: 0, frames: payA, rate: (dur("upload.mp4") - 0.05) / (payA / FPS) },
  live: { src: "live.mp4", trim: 1.2, frames: frames("live"), rate: 1.4 },
  bugAnswer: { src: "answer.mp4", trim: 0, frames: bugA, rate: (dur("answer.mp4") - 0.05) / (bugA / FPS) },
  bugEvidence: { src: "evidence.mp4", trim: 0, frames: bugB, rate: (dur("evidence.mp4") - 0.05) / (bugB / FPS) },
};
await mkdir("public/footage/baked", { recursive: true });
const out = {};
for (const [key, s] of Object.entries(SEGMENTS)) {
  const file = `${key}.mp4`;
  // Pad the tail by holding the last frame so the scene never runs past the clip's end.
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(s.trim), "-i", `public/footage/${s.src}`, "-an",
    "-vf", `setpts=(PTS-STARTPTS)/${s.rate.toFixed(6)},fps=${FPS},tpad=stop_mode=clone:stop_duration=1,format=yuv420p`,
    "-frames:v", String(s.frames + 15), "-c:v", "libx264", "-preset", "medium", "-crf", "15", "-g", "1", "-bf", "0", `public/footage/baked/${file}`]);
  out[key] = { file, rate: Math.round(s.rate * 100) / 100, trim: s.trim, frames: s.frames };
  console.log(key, `${s.rate.toFixed(2)}x`, `${s.frames} frames`);
}
await writeFile("src/baked.json", JSON.stringify(out, null, 2) + "\n");
