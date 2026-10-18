import { AbsoluteFill, Audio, Sequence, interpolate, staticFile, useCurrentFrame } from "remotion";
import timeline from "./timeline.json";
import { Answer, Close, Evidence, Hook, Limits, Memory, Pay, Pipeline, Reveal, Upload } from "./scenes";

export const FPS = 30;
const VO_DELAY = 10; // frames of air before each line
// Extra frames after each voice line, tuned per scene for pacing.
const PAD: Record<string, number> = { hook: 22, reveal: 30, upload: 40, pay: 24, pipeline: 26, answer: 44, evidence: 34, memory: 30, limits: 30, close: 80 };
const SCENES = { hook: Hook, reveal: Reveal, upload: Upload, pay: Pay, pipeline: Pipeline, answer: Answer, evidence: Evidence, memory: Memory, limits: Limits, close: Close };

const plan = (timeline as { id: keyof typeof SCENES; seconds: number }[]).map((t) => ({
  ...t, frames: VO_DELAY + Math.ceil(t.seconds * FPS) + (PAD[t.id] ?? 30),
}));
export const totalFrames = () => plan.reduce((a, s) => a + s.frames, 0);

/** Short cross-fade at every cut. */
function Fade({ frames, children }: { frames: number; children: React.ReactNode }) {
  const f = useCurrentFrame();
  const o = interpolate(f, [0, 8, frames - 6, frames], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>;
}

export function Demo() {
  let from = 0;
  return (
    <AbsoluteFill style={{ background: "#0a0a0b" }}>
      {plan.map((s) => {
        const Scene = SCENES[s.id];
        const at = from;
        from += s.frames;
        return (
          <Sequence key={s.id} from={at} durationInFrames={s.frames} name={s.id}>
            <Fade frames={s.frames}><Scene frames={s.frames} /></Fade>
            <Sequence from={VO_DELAY}><Audio src={staticFile(`audio/${s.id}.wav`)} /></Sequence>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
}
