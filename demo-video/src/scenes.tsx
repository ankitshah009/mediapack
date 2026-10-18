import type { ReactNode } from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { Backdrop, Browser, Captions, Footage, Hi, Kicker, Logo, ease, useIn } from "./ui";
import { C, mono } from "./theme";

type P = { frames: number };
const FOOTAGE_S: Record<string, number> = { "upload.mp4": 25.5, "answer.mp4": 16.4, "evidence.mp4": 13.1, "limits.mp4": 10.5 };
/** Playback rate that fits the whole clip into the scene. */
const fit = (src: string, frames: number) => FOOTAGE_S[src] / ((frames - 6) / 30);

function Pop({ delay, children, style }: { delay: number; children: ReactNode; style?: React.CSSProperties }) {
  const p = useIn(delay, 14);
  return <span style={{ display: "inline-block", opacity: p, transform: `translateY(${(1 - p) * 24}px) scale(${0.92 + 0.08 * p})`, ...style }}>{children}</span>;
}

// 1 ─ Hook
export function Hook(_: P) {
  const f = useCurrentFrame();
  const blind = useIn(150, 12);
  const chip = (t: string, d: number) => (
    <Pop delay={d} style={{ marginLeft: 18, padding: "6px 22px", borderRadius: 16, background: C.panel, border: `1px solid ${C.line}`, fontFamily: mono, fontSize: 54, color: C.lime }}>{t}</Pop>
  );
  return (
    <Backdrop>
      <AbsoluteFill style={{ justifyContent: "center", padding: "0 180px", gap: 46 }}>
        <div style={{ display: "flex", alignItems: "center", fontSize: 76, fontWeight: 700, letterSpacing: -2 }}>
          <Pop delay={8}>Your agent can read</Pop>{chip("code", 30)}{chip("logs", 42)}{chip("docs", 54)}
        </div>
        <div style={{ fontSize: 76, fontWeight: 700, letterSpacing: -2, color: C.muted }}>
          <Pop delay={95}>Hand it a screen recording of a bug…</Pop>
        </div>
        <div style={{ fontSize: 132, fontWeight: 800, letterSpacing: -4, color: C.lime, opacity: blind, transform: `scale(${0.9 + 0.1 * blind})`, transformOrigin: "left center",
          filter: `blur(${interpolate(f, [150, 162], [8, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}px)` }}>
          it&apos;s blind.
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
}

// 2 ─ Reveal
export function Reveal(_: P) {
  const p = useIn(4, 12);
  const t = useIn(14);
  const chips = ["Stripe MPP", "Primitive", "Blaxel", "Supabase", "MCP · Manufact"];
  return (
    <Backdrop>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", gap: 34 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 34, transform: `scale(${0.85 + 0.15 * p})`, opacity: p }}>
          <Logo size={150} />
          <div style={{ fontSize: 150, fontWeight: 800, letterSpacing: -6 }}>MediaPack</div>
        </div>
        <div style={{ fontSize: 50, fontWeight: 500, color: C.muted, opacity: t, transform: `translateY(${(1 - t) * 16}px)` }}>
          Paid, verifiable <Hi>video evidence</Hi> for AI agents.
        </div>
        <div style={{ display: "flex", gap: 14, marginTop: 18 }}>
          {chips.map((c, i) => (
            <Pop key={c} delay={36 + i * 6} style={{ fontFamily: mono, fontSize: 24, padding: "10px 20px", borderRadius: 999, border: `1px solid ${C.line}`, background: C.panel, color: C.text }}>{c}</Pop>
          ))}
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
}

// 3 ─ Upload (live)
export function Upload({ frames }: P) {
  return (
    <Backdrop>
      <Browser url="/app" w={1600} style={{ left: 160, top: 50 }}>
        <Footage src="upload.mp4" rate={fit("upload.mp4", frames)} w={1600} h={900}
          cam={[{ at: 0, x: 960, y: 540, s: 1 }, { at: 285, x: 960, y: 540, s: 1 }, { at: 330, x: 760, y: 360, s: 1.45 }]} />
      </Browser>
      <Captions items={[
        [12, 120, "Upload a real screen recording"],
        [124, 250, <>The server verifies the actual file with <Hi>ffprobe</Hi></>],
        [254, frames, <>Quote frozen: <Hi>$0.50</Hi> · 24h · 3 searches · 8 frames · 15s of clips</>],
      ]} />
    </Backdrop>
  );
}

// 4 ─ Agent pays (HTTP 402 + Stripe MPP), with the real receipt
function Row({ delay, dir, children, color = C.text, note }: { delay: number; dir: "→" | "←" | "↻"; children: ReactNode; color?: string; note?: string }) {
  const p = useIn(delay, 16);
  return (
    <div style={{ display: "flex", gap: 18, alignItems: "baseline", opacity: p, transform: `translateX(${(1 - p) * -24}px)` }}>
      <span style={{ fontFamily: mono, fontSize: 34, color: C.muted, width: 34 }}>{dir}</span>
      <div>
        <div style={{ fontFamily: mono, fontSize: 30, color, lineHeight: 1.35 }}>{children}</div>
        {note && <div style={{ fontSize: 22, color: C.muted, marginTop: 4 }}>{note}</div>}
      </div>
    </div>
  );
}

export function Pay({ frames }: P) {
  const f = useCurrentFrame();
  const r = useIn(150, 20);
  return (
    <Backdrop>
      <div style={{ position: "absolute", left: 100, top: 110, width: 900 }}>
        <Kicker color={C.stripe}>Agent ⇄ MediaPack · HTTP 402 · Stripe MPP</Kicker>
        <div style={{ marginTop: 30, padding: "40px 40px", borderRadius: 26, background: C.panel, border: `1px solid ${C.line}`, display: "flex", flexDirection: "column", gap: 30 }}>
          <Row delay={14} dir="→" note="agent asks to buy the frozen quote">POST /v1/jobs/bb641bda…/purchase</Row>
          <Row delay={64} dir="←" color={C.stripe} note="machine-readable price, no checkout page">402 Payment Required · $0.50 USD</Row>
          <Row delay={120} dir="→" note="Stripe test mode · shared payment token">retry with payment credential</Row>
          <Row delay={176} dir="←" color={C.lime} note="verified server-side, then indexing is queued">200 · PaymentIntent verified · job active</Row>
          <Row delay={250} dir="↻" color={C.muted} note="purchase is idempotent on quote_id">same quote again → same job, no second charge</Row>
        </div>
      </div>
      <div style={{ position: "absolute", right: 90, top: 210, width: 780, height: 660, borderRadius: 24, overflow: "hidden", opacity: r,
        transform: `translateY(${(1 - r) * 30}px)`, boxShadow: "0 30px 90px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.08)" }}>
        <Still src="receipt.png" x0={1384} y0={164} x1={1890} y1={790} w={780} h={660} zoom={interpolate(f, [150, frames], [1, 1.06], { extrapolateLeft: "clamp" })} />
      </div>
      <div style={{ position: "absolute", right: 90, top: 160, fontFamily: mono, fontSize: 20, color: C.muted, opacity: r }}>REAL RECEIPT · LIVE DASHBOARD</div>
    </Backdrop>
  );
}

/** Crop a full-resolution still (footage pixels) into a w×h box. */
function Still({ src, x0, y0, x1, y1, w, h, zoom = 1 }: { src: string; x0: number; y0: number; x1: number; y1: number; w: number; h: number; zoom?: number }) {
  // Fit the crop's width; anchor its top edge (cards read top-down).
  const s = (w / (x1 - x0)) * zoom;
  const cx = (x0 + x1) / 2, cy = y0 + h / (2 * s);
  return (
    <div style={{ position: "relative", width: w, height: h, overflow: "hidden", background: C.paper }}>
      <Img src={staticFile(`stills/${src}`)} style={{ position: "absolute", width: 1920 * s, height: 1080 * s, left: w / 2 - cx * s, top: h / 2 - cy * s, maxWidth: "none" }} />
    </div>
  );
}

// 5 ─ Durable pipeline
const NODES = [
  { label: "Agent", sub: "CLI · MCP · browser", color: C.text, x: 300, y: 330 },
  { label: "Next.js API", sub: "on Blaxel", color: C.lime, x: 740, y: 330 },
  { label: "Outbox", sub: "Postgres, written first", color: C.text, x: 1180, y: 330 },
  { label: "Primitive", sub: "signed work request", color: C.primitive, x: 1620, y: 330 },
  { label: "Blaxel worker", sub: "ffmpeg · Whisper · vision", color: C.worker, x: 1620, y: 650 },
  { label: "Signed result", sub: "webhook, deduplicated", color: C.primitive, x: 1180, y: 650 },
  { label: "Events", sub: "Postgres + Storage", color: C.text, x: 740, y: 650 },
  { label: "Dashboard", sub: "persisted events only", color: C.lime, x: 300, y: 650 },
];

export function Pipeline({ frames }: P) {
  const f = useCurrentFrame();
  const travel = interpolate(f, [40, frames - 40], [0, NODES.length - 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const i = Math.min(NODES.length - 2, Math.floor(travel));
  const t = travel - i;
  const a = NODES[i], b = NODES[i + 1];
  const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
  return (
    <Backdrop>
      <div style={{ position: "absolute", left: 100, top: 70 }}><Kicker color={C.primitive}>Crash-safe by construction</Kicker></div>
      <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }}>
        {NODES.slice(1).map((n, k) => {
          const m = NODES[k];
          const on = travel >= k;
          return <line key={k} x1={m.x} y1={m.y} x2={n.x} y2={n.y} stroke={on ? C.lime : C.line} strokeWidth={on ? 4 : 3} strokeDasharray={on ? "0" : "8 10"} opacity={on ? 0.75 : 1} />;
        })}
        <circle cx={px} cy={py} r={16} fill={C.lime} opacity={0.25} />
        <circle cx={px} cy={py} r={8} fill={C.lime} />
      </svg>
      {NODES.map((n, k) => {
        const p = useIn(6 + k * 5, 16);
        const lit = travel >= k - 0.2;
        return (
          <div key={n.label} style={{ position: "absolute", left: n.x - 190, top: n.y - 70, width: 380, height: 140, borderRadius: 22, background: C.panel,
            border: `2px solid ${lit ? n.color : C.line}`, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center",
            opacity: p, transform: `scale(${0.9 + 0.1 * p})`, boxShadow: lit ? `0 0 40px ${n.color}33` : "none" }}>
            <div style={{ fontSize: 38, fontWeight: 700, color: lit ? n.color : C.text }}>{n.label}</div>
            <div style={{ fontSize: 22, color: C.muted, marginTop: 8, fontFamily: mono, whiteSpace: "nowrap" }}>{n.sub}</div>
          </div>
        );
      })}
      <Captions items={[[20, frames, <><Hi>Persisted before it happens:</Hi> a crash resumes, never double-runs</>]]} />
    </Backdrop>
  );
}

// 6 ─ The answer (live)
export function Answer({ frames }: P) {
  const rate = fit("answer.mp4", frames);
  const k = (footageS: number) => Math.round((footageS / rate) * 30);
  return (
    <Backdrop>
      <Browser url="/app/jobs/bb641bda…" w={1600} style={{ left: 160, top: 50 }}>
        <Footage src="answer.mp4" rate={rate} w={1600} h={900}
          cam={[{ at: 0, x: 740, y: 545, s: 1.4 }, { at: k(4.9), x: 740, y: 545, s: 1.4 }, { at: k(6.9), x: 723, y: 580, s: 1.3 }]} />
      </Browser>
      <Captions items={[
        [10, k(5.2), <>The answer cites the exact seconds: <Hi>0:40–0:48</Hi></>],
        [k(5.2) + 4, frames, <>Saved as <Hi>60</Hi> → shows <Hi color={C.danger}>30</Hi> after reload. Click jumps the source there.</>],
      ]} />
    </Backdrop>
  );
}

// 7 ─ Evidence (live)
export function Evidence({ frames }: P) {
  return (
    <Backdrop>
      <Browser url="/app/jobs/bb641bda…" w={1600} style={{ left: 160, top: 50 }}>
        <Footage src="evidence.mp4" rate={fit("evidence.mp4", frames)} w={1600} h={900}
          cam={[{ at: 0, x: 740, y: 420, s: 1.25 }, { at: 70, x: 740, y: 640, s: 1.2 }]} />
      </Browser>
      <Captions items={[[8, frames, <>Retrieve only what&apos;s cited: frames + clips, each <Hi>SHA-256</Hi> verified</>]]} />
    </Backdrop>
  );
}

// 8 ─ Reusable memory (measured numbers from docs/efficiency-and-memory.md)
function Bar({ label, value, max, color, delay, unit }: { label: string; value: number; max: number; color: string; delay: number; unit: string }) {
  const f = useCurrentFrame();
  const p = interpolate(f, [delay, delay + 40], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const shown = Math.round(value * p);
  return (
    <div style={{ marginBottom: 46 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
        <span style={{ fontSize: 38, fontWeight: 600 }}>{label}</span>
        <span style={{ fontFamily: mono, fontSize: 52, fontWeight: 700, color }}>{shown.toLocaleString("en-US")} <span style={{ fontSize: 26, color: C.muted }}>{unit}</span></span>
      </div>
      <div style={{ height: 28, borderRadius: 14, background: C.panel, border: `1px solid ${C.line}`, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${Math.max(0.6, (value / max) * 100) * p}%`, background: color, borderRadius: 14 }} />
      </div>
    </div>
  );
}

export function Memory({ frames }: P) {
  const big = useIn(230, 12);
  return (
    <Backdrop>
      <AbsoluteFill style={{ padding: "110px 200px", justifyContent: "center" }}>
        <Kicker>Index once · ask many times</Kicker>
        <div style={{ height: 50 }} />
        <Bar label="Index the video (once)" value={326710} max={326710} color={C.worker} delay={30} unit="input tokens" />
        <Bar label="Each follow-up question" value={2507} max={326710} color={C.lime} delay={150} unit="input tokens" />
        <div style={{ display: "flex", alignItems: "baseline", gap: 26, opacity: big, transform: `translateY(${(1 - big) * 20}px)` }}>
          <span style={{ fontSize: 120, fontWeight: 800, letterSpacing: -4, color: C.lime }}>~130×</span>
          <span style={{ fontSize: 44, fontWeight: 600 }}>smaller per question</span>
        </div>
        <div style={{ marginTop: 26, fontSize: 22, color: C.muted, fontFamily: mono, opacity: big }}>Measured input tokens from one recorded run · docs/efficiency-and-memory.md</div>
      </AbsoluteFill>
      <div style={{ display: "none" }}>{frames}</div>
    </Backdrop>
  );
}

// 9 ─ Limits (real UI)
export function Limits({ frames }: P) {
  const a = useIn(8, 18), b = useIn(70, 18), c = useIn(130, 18);
  const f = useCurrentFrame();
  const z = interpolate(f, [0, frames], [1, 1.03]);
  const card = { borderRadius: 22, overflow: "hidden", boxShadow: "0 30px 90px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.08)" } as const;
  return (
    <Backdrop>
      <div style={{ position: "absolute", left: 120, top: 80 }}><Kicker>Guardrails in the database</Kicker></div>
      <div style={{ position: "absolute", left: 120, top: 140, opacity: a, transform: `translateY(${(1 - a) * 30}px)`, ...card }}>
        <Still src="top.png" x0={176} y0={384} x1={1270} y1={484} w={1680} h={154} zoom={z} />
      </div>
      <div style={{ position: "absolute", left: 120, top: 350, opacity: b, transform: `translateY(${(1 - b) * 30}px)`, ...card }}>
        <Still src="allowance.png" x0={1384} y0={560} x1={1890} y1={1000} w={700} h={608} zoom={z} />
      </div>
      <div style={{ position: "absolute", left: 900, top: 420, width: 900, opacity: c, transform: `translateY(${(1 - c) * 20}px)` }}>
        <div style={{ fontSize: 64, fontWeight: 800, letterSpacing: -2, lineHeight: 1.1 }}>Allowance is enforced <Hi>inside Postgres.</Hi></div>
        <div style={{ fontSize: 40, fontWeight: 600, color: C.muted, marginTop: 24 }}>A looping agent can&apos;t overspend.</div>
        <div style={{ fontSize: 28, color: C.muted, marginTop: 40, lineHeight: 1.5 }}>
          Every API error returns <span style={{ fontFamily: mono, color: C.text }}>{"{error, hint, next_action}"}</span> so the agent knows what to do next.
        </div>
      </div>
    </Backdrop>
  );
}

// 10 ─ Close
export function Close(_: P) {
  const p = useIn(4, 14), q = useIn(30), r = useIn(60);
  const chips = ["Stripe MPP (test mode)", "Primitive", "Blaxel", "Supabase", "MCP on Manufact"];
  return (
    <Backdrop>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", gap: 30 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 28, opacity: p, transform: `scale(${0.9 + 0.1 * p})` }}>
          <Logo size={110} /><div style={{ fontSize: 110, fontWeight: 800, letterSpacing: -4 }}>MediaPack</div>
        </div>
        <div style={{ fontSize: 40, color: C.muted, opacity: q }}>Agents pay for video evidence — and get proof back.</div>
        <div style={{ display: "flex", gap: 12, opacity: q }}>
          {chips.map((c) => <span key={c} style={{ fontFamily: mono, fontSize: 22, padding: "8px 18px", borderRadius: 999, border: `1px solid ${C.line}`, background: C.panel }}>{c}</span>)}
        </div>
        <div style={{ marginTop: 26, display: "flex", flexDirection: "column", alignItems: "center", gap: 14, opacity: r, transform: `translateY(${(1 - r) * 16}px)` }}>
          <div style={{ fontFamily: mono, fontSize: 40, color: C.lime }}>mediapack-mediapack.preview.bl.run</div>
          <div style={{ fontFamily: mono, fontSize: 34, color: C.text }}>github.com/ankitshah009/mediapack</div>
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
}
