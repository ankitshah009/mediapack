import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, Easing, interpolate, OffthreadVideo, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { C, mono, sans } from "./theme";

export const ease = Easing.bezier(0.22, 1, 0.36, 1);

/** 0→1 entrance progress starting at `delay` frames. */
export function useIn(delay = 0, damping = 18) {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: f - delay, fps, config: { damping, mass: 0.8 } });
}

export function Backdrop({ children }: { children?: ReactNode }) {
  const f = useCurrentFrame();
  const drift = interpolate(f, [0, 900], [0, 60]);
  return (
    <AbsoluteFill style={{ background: C.bg, fontFamily: sans, color: C.text }}>
      <AbsoluteFill style={{
        backgroundImage: `linear-gradient(${C.line}55 1px, transparent 1px), linear-gradient(90deg, ${C.line}55 1px, transparent 1px)`,
        backgroundSize: "64px 64px", backgroundPosition: `${drift}px ${drift}px`, opacity: 0.35,
        maskImage: "radial-gradient(ellipse at center, black 30%, transparent 75%)",
      }} />
      <AbsoluteFill style={{ background: `radial-gradient(900px 500px at 20% 10%, ${C.lime}14, transparent 60%), radial-gradient(800px 500px at 90% 100%, ${C.stripe}14, transparent 60%)` }} />
      {children}
    </AbsoluteFill>
  );
}

export type Cam = { at: number; x: number; y: number; s: number };

/** Camera over 1920x1080 footage: keyframes in scene frames, focus point in footage pixels. */
function camAt(keys: Cam[], f: number) {
  if (keys.length === 1 || f <= keys[0].at) return keys[0];
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    if (f <= b.at) {
      const t = ease((f - a.at) / Math.max(1, b.at - a.at));
      return { at: f, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, s: a.s + (b.s - a.s) * t };
    }
  }
  return keys[keys.length - 1];
}

export function Footage({ src, rate = 1, from = 0, cam = [{ at: 0, x: 960, y: 540, s: 1 }], w, h }: {
  src: string; rate?: number; from?: number; cam?: Cam[]; w: number; h: number;
}) {
  const f = useCurrentFrame();
  const k = camAt(cam, f);
  const base = w / 1920;
  const scale = base * k.s;
  // Keep the focus point centered, clamped so no empty edge shows.
  const tx = Math.min(0, Math.max(w - 1920 * scale, w / 2 - k.x * scale));
  const ty = Math.min(0, Math.max(h - 1080 * scale, h / 2 - k.y * scale));
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: C.paper }}>
      <div style={{ position: "absolute", left: 0, top: 0, width: 1920, height: 1080, transformOrigin: "0 0", transform: `translate(${tx}px, ${ty}px) scale(${scale})` }}>
        <OffthreadVideo src={staticFile(`footage/${src}`)} playbackRate={rate} trimBefore={from} muted style={{ width: 1920, height: 1080 }} />
      </div>
    </div>
  );
}

/** macOS-style browser window with the live URL. */
export function Browser({ url, children, style, w = 1600, delay = 0, enter = true }: { url: string; children: ReactNode; style?: CSSProperties; w?: number; delay?: number; enter?: boolean }) {
  const spring = useIn(delay, 20);
  const p = enter ? spring : 1; // no entrance when dissolving in under the previous shot
  const h = Math.round((w * 9) / 16);
  return (
    <div style={{
      position: "absolute", width: w, height: h + 46, borderRadius: 18, overflow: "hidden", background: "#1b1b1e",
      boxShadow: "0 40px 120px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.08)",
      transform: `translateY(${(1 - p) * 40}px) scale(${0.97 + 0.03 * p})`, opacity: p, ...style,
    }}>
      <div style={{ height: 46, display: "flex", alignItems: "center", gap: 9, padding: "0 18px", background: "#1b1b1e", borderBottom: "1px solid #2a2a2e" }}>
        {["#ff5f57", "#febc2e", "#28c840"].map((c) => <span key={c} style={{ width: 13, height: 13, borderRadius: 7, background: c }} />)}
        <div style={{ marginLeft: 18, flex: 1, maxWidth: 760, height: 28, borderRadius: 8, background: "#0f0f11", display: "flex", alignItems: "center", gap: 8, padding: "0 12px", fontFamily: mono, fontSize: 15, color: C.muted }}>
          <span style={{ color: C.lime }}>●</span>
          <span><span style={{ color: C.text }}>mediapack-mediapack.preview.bl.run</span>{url}</span>
        </div>
        <div style={{ marginLeft: "auto", fontFamily: mono, fontSize: 13, color: C.lime, border: `1px solid ${C.lime}55`, borderRadius: 999, padding: "3px 10px" }}>LIVE · Stripe test mode</div>
      </div>
      <div style={{ position: "relative", width: w, height: h }}>{children}</div>
    </div>
  );
}

/** Fade a sub-shot out over `frames` starting at `start` (frames relative to its Sequence). */
export function FadeOut({ start, frames = 10, children }: { start: number; frames?: number; children: ReactNode }) {
  const f = useCurrentFrame();
  const o = interpolate(f, [start, start + frames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>;
}

/** Bottom caption pill; each item = [startFrame, endFrame, text]. */
export function Captions({ items }: { items: [number, number, ReactNode][] }) {
  const f = useCurrentFrame();
  const cur = items.find(([a, b]) => f >= a && f < b);
  if (!cur) return null;
  const [a, b, text] = cur;
  const o = interpolate(f, [a, a + 8, b - 8, b], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const y = interpolate(f, [a, a + 12], [16, 0], { extrapolateRight: "clamp", easing: ease });
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 44, display: "flex", justifyContent: "center", opacity: o, transform: `translateY(${y}px)` }}>
      <div style={{ maxWidth: 1500, padding: "18px 34px", borderRadius: 22, background: "rgba(10,10,11,.86)", backdropFilter: "blur(12px)", border: "1px solid rgba(255,255,255,.1)", fontSize: 42, fontWeight: 600, letterSpacing: -0.6, textAlign: "center", lineHeight: 1.25 }}>
        {text}
      </div>
    </div>
  );
}

export function Kicker({ children, color = C.lime, delay = 0 }: { children: ReactNode; color?: string; delay?: number }) {
  const p = useIn(delay);
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 10, fontFamily: mono, fontSize: 20, letterSpacing: 2, textTransform: "uppercase", color, opacity: p, transform: `translateY(${(1 - p) * 10}px)` }}>
      <span style={{ width: 10, height: 10, borderRadius: 5, background: color }} />{children}
    </div>
  );
}

export const Hi = ({ children, color = C.lime }: { children: ReactNode; color?: string }) => <span style={{ color }}>{children}</span>;

export function Logo({ size = 120 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      <rect x="4" y="4" width="28" height="28" rx="8" stroke={C.text} strokeWidth="3.2" />
      <rect x="18" y="18" width="26" height="26" rx="7" fill={C.lime} />
    </svg>
  );
}
