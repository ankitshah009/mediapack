import { AbsoluteFill, Audio, Sequence, interpolate, staticFile, useCurrentFrame } from "remotion";
import timeline from "./timeline.json";
import { Bug, Close, Hard, Hook, Live, Memory, Pay, Primitive, Reveal, Value } from "./scenes";
import { FPS, VO_DELAY } from "./timing";

export { FPS };
import pads from "./pads.json";

// Extra frames after each voice line, tuned per scene for pacing (the whole cut stays under 2:00). Shared with bake.mjs.
const PAD: Record<string, number> = pads;
const SCENES = { hook: Hook, hard: Hard, reveal: Reveal, pay: Pay, primitive: Primitive, live: Live, bug: Bug, memory: Memory, value: Value, close: Close };

const plan = (timeline as { id: keyof typeof SCENES; seconds: number }[]).map((t) => ({
  ...t, frames: VO_DELAY + Math.ceil(t.seconds * FPS) + (PAD[t.id] ?? PAD.default),
}));
export const totalFrames = () => plan.reduce((a, s) => a + s.frames, 0);

/** Short cross-fade at every cut. */
function Fade({ frames, children }: { frames: number; children: React.ReactNode }) {
  const f = useCurrentFrame();
  const o = interpolate(f, [0, 6, frames - 5, frames], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>;
}

export function Demo() {
  let from = 0;
  return (
    <AbsoluteFill style={{ background: "#0a0a0b" }}>
      <Audio src={staticFile("audio/bed.wav")} volume={0.3} />
      {plan.map((s) => {
        const Scene = SCENES[s.id];
        const start = from;
        from += s.frames;
        return (
          <Sequence key={s.id} from={start} durationInFrames={s.frames} name={s.id}>
            <Fade frames={s.frames}><Scene frames={s.frames} /></Fade>
            <Sequence from={VO_DELAY}><Audio src={staticFile(`audio/${s.id}.wav`)} /></Sequence>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
}
