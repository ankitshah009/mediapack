import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, Img, Sequence, interpolate, staticFile, useCurrentFrame } from "remotion";
import { Architecture, type NodeId } from "./Architecture";
import { C, mono, sans } from "./theme";
import { at, sec } from "./timing";
import { Backdrop, Browser, Captions, Footage, Hi, Kicker, Logo, ease, useIn } from "./ui";

type P = { frames: number };
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

function Pop({ delay, children, style }: { delay: number; children: ReactNode; style?: CSSProperties }) {
  const p = useIn(delay, 14);
  return <div style={{ opacity: p, transform: `translateY(${(1 - p) * 26}px) scale(${0.94 + 0.06 * p})`, ...style }}>{children}</div>;
}

/** Crop a full-resolution still (footage pixels): fit the crop width, anchor its top. */
function Still({ src, x0, y0, x1, w, h, zoom = 1 }: { src: string; x0: number; y0: number; x1: number; w: number; h: number; zoom?: number }) {
  const s = (w / (x1 - x0)) * zoom;
  const cx = (x0 + x1) / 2, cy = y0 + h / (2 * s);
  return (
    <div style={{ position: "relative", width: w, height: h, overflow: "hidden", background: C.paper }}>
      <Img src={staticFile(`stills/${src}`)} style={{ position: "absolute", width: 1920 * s, height: 1080 * s, left: w / 2 - cx * s, top: h / 2 - cy * s, maxWidth: "none" }} />
    </div>
  );
}

const SpeedTag = ({ children }: { children: ReactNode }) => (
  <div style={{ position: "absolute", left: 160, top: 12, zIndex: 5, fontFamily: mono, fontSize: 18, color: C.bg, background: C.lime, borderRadius: 8, padding: "4px 10px", fontWeight: 700 }}>{children}</div>
);

// 1 ─ Where knowledge lives, and agents can't see it
const TILES = [
  { name: "bug-report.mp4", dur: "0:53", tag: "Bug report", img: "thumb-bug.jpg" },
  { name: "standup-tuesday.mp4", dur: "14:02", tag: "Meeting", hue: 212 },
  { name: "lecture-07.mp4", dur: "48:31", tag: "Lecture", img: "thumb-talk.jpg" },
  { name: "support-call.webm", dur: "9:12", tag: "Support call", hue: 160 },
  { name: "product-demo.mp4", dur: "3:45", tag: "Product demo", hue: 280 },
  { name: "incident-cam.mp4", dur: "6:18", tag: "Security footage", hue: 18 },
];
export function Hook(_: P) {
  const f = useCurrentFrame();
  const t1 = at("hook", 1), t2 = at("hook", 2), t3 = at("hook", 3);
  const dim = interpolate(f, [t2 - 6, t2 + 10], [1, 0.22], clamp);
  const blind = useIn(t3 + sec(1.05), 11);
  const row = (label: string, ok: boolean, d: number) => (
    <Pop delay={d} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 24px", borderRadius: 16, background: ok ? "#1b2210" : "#2a1412", border: `1px solid ${ok ? C.lime + "55" : C.danger + "77"}` }}>
      <span style={{ fontFamily: mono, fontSize: 38 }}>{label}</span>
      <span style={{ fontSize: 42, fontWeight: 800, color: ok ? C.lime : C.danger }}>{ok ? "✓" : "✗"}</span>
    </Pop>
  );
  return (
    <Backdrop>
      <div style={{ position: "absolute", left: 100, top: 70 }}><Kicker>Where team knowledge lives now</Kicker></div>
      <div style={{ position: "absolute", left: 230, top: 170, width: 1460, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 36, opacity: dim, filter: `blur(${(1 - dim) * 3}px)` }}>
        {TILES.map((t, i) => (
          <Pop key={t.name} delay={t1 + sec([0, 0.55, 1.05, 1.6, 2.0, 2.35][i])}>
            <div style={{ position: "relative", height: 300, borderRadius: 22, overflow: "hidden", border: "1px solid rgba(255,255,255,.1)",
              background: t.img ? C.paper : `linear-gradient(135deg, hsl(${t.hue} 45% 22%), hsl(${(t.hue ?? 0) + 40} 40% 12%))` }}>
              {t.img && <Img src={staticFile(`stills/${t.img}`)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
              <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
                <div style={{ width: 78, height: 78, borderRadius: 39, background: "rgba(10,10,11,.66)", display: "grid", placeItems: "center", fontSize: 32, color: "#fff" }}>▶</div>
              </div>
              <div style={{ position: "absolute", left: 16, top: 14, fontSize: 20, fontWeight: 700, padding: "6px 14px", borderRadius: 999, background: "rgba(10,10,11,.75)", color: C.text }}>{t.tag}</div>
              <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: "14px 18px", display: "flex", justifyContent: "space-between", background: "linear-gradient(transparent, rgba(0,0,0,.8))", fontFamily: mono, fontSize: 20, color: "#eee" }}>
                <span>{t.name}</span><span>{t.dur}</span>
              </div>
            </div>
          </Pop>
        ))}
      </div>
      {f >= t2 - 4 && (
        <div style={{ position: "absolute", left: 560, top: 190, width: 800, display: "flex", flexDirection: "column", gap: 16 }}>
          <Pop delay={t2 - 4} style={{ fontFamily: mono, fontSize: 24, letterSpacing: 2, color: C.muted, marginBottom: 6 }}>YOUR AGENT CAN READ…</Pop>
          {row("code", true, t2 + 4)}
          {row("logs", true, t2 + 14)}
          {row("docs", true, t2 + 24)}
          {row("video", false, t3 + sec(0.9))}
          <div style={{ marginTop: 18, fontSize: 92, fontWeight: 800, letterSpacing: -3, color: C.danger, opacity: blind, transform: `scale(${0.9 + 0.1 * blind})`, transformOrigin: "left center" }}>…and it&apos;s blind.</div>
        </div>
      )}
    </Backdrop>
  );
}

// 2 ─ Why video is hard
const HARD = [
  { metric: "1,800", unit: "frames / minute", title: "Huge", body: "at 30 fps, far more than a model can read at once" },
  { metric: "2", unit: "signals", title: "Shown + said", body: "pixels and speech must line up on one timeline" },
  { metric: "326,710", unit: "tokens", title: "Expensive", body: "one vision pass over a 46-second clip (measured)" },
  { metric: "0", unit: "timestamps", title: "Unprovable", body: "answers can't be checked against the source" },
  { metric: "0", unit: "ways to pay", title: "Locked out", body: "agents can't sign up, add a card or hold keys" },
];
export function Hard(_: P) {
  const times = [at("hard", 1), at("hard", 1, 2.3), at("hard", 2), at("hard", 3), at("hard", 4)];
  return (
    <Backdrop>
      <div style={{ position: "absolute", left: 100, top: 70 }}><Kicker color={C.danger}>Why video is hard for agents</Kicker></div>
      <Pop delay={4} style={{ position: "absolute", left: 100, top: 130, fontSize: 70, fontWeight: 800, letterSpacing: -2 }}>
        Video isn&apos;t text. <span style={{ color: C.muted }}>That&apos;s the whole problem.</span>
      </Pop>
      <div style={{ position: "absolute", left: 100, top: 300, width: 1720, display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 22 }}>
        {HARD.map((h, i) => (
          <Pop key={h.title} delay={times[i]}>
            <div style={{ height: 520, boxSizing: "border-box", borderRadius: 24, padding: "30px 26px", background: C.panel, border: `1px solid ${C.danger}44`, display: "flex", flexDirection: "column" }}>
              <div style={{ fontFamily: mono, fontSize: h.metric.length > 4 ? 60 : 84, fontWeight: 700, color: C.danger, letterSpacing: -2 }}>{h.metric}</div>
              <div style={{ fontFamily: mono, fontSize: 22, color: C.muted, marginTop: 4 }}>{h.unit}</div>
              <div style={{ marginTop: "auto", fontSize: 40, fontWeight: 800 }}>{h.title}</div>
              <div style={{ fontSize: 25, lineHeight: 1.35, color: C.muted, marginTop: 10 }}>{h.body}</div>
            </div>
          </Pop>
        ))}
      </div>
    </Backdrop>
  );
}

// 3 ─ The fix
const PILLARS = [
  { glyph: "◎", title: "Index once", sub: "vision + speech → one timestamped memory" },
  { glyph: "?", title: "Ask anything", sub: "plain-language questions, any video" },
  { glyph: "⏱", title: "Pinned to the second", sub: "every answer cites its time range" },
  { glyph: "✓", title: "With proof", sub: "source frames & clips, SHA-256" },
  { glyph: "$", title: "Pay per use", sub: "$0.50 over HTTP 402, no account" },
];
export function Reveal(_: P) {
  const p = useIn(2, 12);
  const times = [at("reveal", 1), at("reveal", 1, 1.25), at("reveal", 1, 2.3), at("reveal", 1, 3.6), at("reveal", 2)];
  return (
    <Backdrop>
      <AbsoluteFill style={{ alignItems: "center", paddingTop: 170 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 30, opacity: p, transform: `scale(${0.86 + 0.14 * p})` }}>
          <Logo size={130} /><div style={{ fontSize: 140, fontWeight: 800, letterSpacing: -5 }}>MediaPack</div>
        </div>
        <Pop delay={14} style={{ fontSize: 46, fontWeight: 600, color: C.muted, marginTop: 18 }}>
          Video that agents can <Hi>search</Hi>, <Hi>pay for</Hi>, and <Hi>prove</Hi>.
        </Pop>
      </AbsoluteFill>
      <div style={{ position: "absolute", left: 100, top: 600, width: 1720, display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 22 }}>
        {PILLARS.map((x, i) => (
          <Pop key={x.title} delay={times[i]}>
            <div style={{ height: 300, boxSizing: "border-box", borderRadius: 24, padding: "28px 24px", background: C.panel, border: `1px solid ${C.lime}44` }}>
              <div style={{ width: 70, height: 70, borderRadius: 18, background: C.lime, color: C.limeInk, display: "grid", placeItems: "center", fontSize: 38, fontWeight: 800 }}>{x.glyph}</div>
              <div style={{ fontSize: 34, fontWeight: 800, marginTop: 24 }}>{x.title}</div>
              <div style={{ fontSize: 23, color: C.muted, marginTop: 10, lineHeight: 1.35 }}>{x.sub}</div>
            </div>
          </Pop>
        ))}
      </div>
    </Backdrop>
  );
}

// 4 ─ Upload, then the agent pays (HTTP 402 + Stripe MPP) — real upload footage and real receipt
function Row({ delay, dir, children, color = C.text, note }: { delay: number; dir: string; children: ReactNode; color?: string; note?: string }) {
  const p = useIn(delay, 16);
  return (
    <div style={{ display: "flex", gap: 18, alignItems: "baseline", opacity: p, transform: `translateX(${(1 - p) * -24}px)` }}>
      <span style={{ fontFamily: mono, fontSize: 32, color: C.muted, width: 32 }}>{dir}</span>
      <div>
        <div style={{ fontFamily: mono, fontSize: 29, color, lineHeight: 1.35 }}>{children}</div>
        {note && <div style={{ fontSize: 22, color: C.muted, marginTop: 4 }}>{note}</div>}
      </div>
    </div>
  );
}
function Stamp({ delay, children }: { delay: number; children: ReactNode }) {
  const p = useIn(delay, 10);
  return (
    <div style={{ opacity: p, transform: `scale(${1.25 - 0.25 * p}) rotate(${(1 - p) * -4}deg)`, fontSize: 46, fontWeight: 800, color: C.lime, border: `3px solid ${C.lime}`, borderRadius: 16, padding: "10px 26px", letterSpacing: -0.5 }}>{children}</div>
  );
}
export function Pay({ frames }: P) {
  const split = at("pay", 2);
  const uploadRate = 25.5 / ((split - 4) / 30);
  return (
    <Backdrop>
      <Sequence durationInFrames={split}>
        <SpeedTag>{uploadRate.toFixed(1)}× · LIVE SITE</SpeedTag>
        <Browser url="/app" w={1600} style={{ left: 160, top: 50 }}>
          <Footage src="upload.mp4" rate={uploadRate} w={1600} h={900}
            cam={[{ at: 0, x: 960, y: 540, s: 1 }, { at: split - 46, x: 960, y: 540, s: 1 }, { at: split - 14, x: 760, y: 360, s: 1.4 }]} />
        </Browser>
        <Captions items={[[6, at("pay", 1), "Upload a recording"], [at("pay", 1) + 2, split, <>Server verifies the real file → <Hi>$0.50</Hi> quote</>]]} />
      </Sequence>
      <Sequence from={split}>
        <div style={{ position: "absolute", left: 100, top: 90, width: 900 }}>
          <Kicker color={C.stripe}>Agent ⇄ MediaPack · HTTP 402 · Stripe MPP</Kicker>
          <div style={{ marginTop: 26, padding: "34px 36px", borderRadius: 26, background: C.panel, border: `1px solid ${C.line}`, display: "flex", flexDirection: "column", gap: 24 }}>
            <Row delay={6} dir="→" note="agent asks to buy the frozen quote">POST /v1/jobs/…/purchase</Row>
            <Row delay={at("pay", 3) - split} dir="←" color={C.stripe} note="a machine-readable price, not a checkout page">402 Payment Required · $0.50</Row>
            <Row delay={at("pay", 3) - split + 30} dir="→" note="Stripe test mode · shared payment token">retry with payment credential</Row>
            <Row delay={at("pay", 3) - split + 56} dir="←" color={C.lime} note="verified server-side · idempotent on quote_id">200 · paid · job active</Row>
          </div>
        </div>
        <div style={{ position: "absolute", right: 90, top: 150, width: 760, height: 560, borderRadius: 24, overflow: "hidden", boxShadow: "0 30px 90px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.08)" }}>
          <Still src="receipt.png" x0={1384} y0={164} x1={1890} w={760} h={560} />
        </div>
        <div style={{ position: "absolute", right: 90, top: 112, fontFamily: mono, fontSize: 19, color: C.muted }}>REAL RECEIPT · LIVE DASHBOARD</div>
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 70, display: "flex", justifyContent: "center", gap: 30 }}>
          <Stamp delay={at("pay", 4) - split}>No account</Stamp>
          <Stamp delay={at("pay", 5) - split}>No API key</Stamp>
          <Stamp delay={at("pay", 6) - split}>No checkout</Stamp>
        </div>
      </Sequence>
      <div style={{ display: "none" }}>{frames}</div>
    </Backdrop>
  );
}

// 5 ─ Primitive: the work order and result are a real email thread (values fetched from Primitive's API)
const ORDER = [
  ['"kind"', '"work_request"'], ['"action"', '"index_video"'], ['"job_id"', '"bb641bda-2ca7-…"'],
  ['"source_sha256"', '"09f5e17a793f457f…"'], ['"generation"', "1"],
];
const RESULT = [
  ['"kind"', '"work_result"'], ['"status"', '"succeeded"'], ['"duration_ms"', "53120"],
  ['"record_counts"', '{ "frame": 27 }'], ['"index_sha256"', '"55a8433c008ea970…"'], ['"artifacts"', "28 items"],
];
function Json({ rows }: { rows: string[][] }) {
  return (
    <div style={{ fontFamily: mono, fontSize: 20, lineHeight: 1.42, color: C.text, background: "#0d0d0f", borderRadius: 12, padding: "10px 16px", marginTop: 10 }}>
      {"{"}
      {rows.map(([k, v]) => <div key={k} style={{ paddingLeft: 22 }}><span style={{ color: C.primitive }}>{k}</span>: <span style={{ color: v.startsWith('"') ? C.lime : C.worker }}>{v}</span>,</div>)}
      {"}"}
    </div>
  );
}
function Mail({ delay, from, to, time, subject, rows, extra }: { delay: number; from: string; to: string; time: string; subject: string; rows: string[][]; extra?: ReactNode }) {
  return (
    <Pop delay={delay} style={{ borderRadius: 18, background: C.panel, border: `1px solid ${C.primitive}55`, padding: "14px 20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontFamily: mono, fontSize: 20, color: C.muted }}>
        <span><span style={{ color: C.text }}>{from}</span> → {to}</span><span>{time}{extra}</span>
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, marginTop: 8 }}>{subject}</div>
      <Json rows={rows} />
    </Pop>
  );
}
function Badge({ delay, children }: { delay: number; children: ReactNode }) {
  return (
    <Pop delay={delay} style={{ display: "flex", gap: 16, alignItems: "flex-start", padding: "22px 24px", borderRadius: 18, background: "#0f1f1d", border: `1px solid ${C.primitive}66` }}>
      <span style={{ fontSize: 34, color: C.primitive, fontWeight: 800 }}>✓</span><div style={{ fontSize: 28, lineHeight: 1.3 }}>{children}</div>
    </Pop>
  );
}
export function Primitive(_: P) {
  const f = useCurrentFrame();
  const order = at("primitive", 2), work = at("primitive", 2, 2.2), result = at("primitive", 2, 4.4);
  const bar = interpolate(f, [work + 6, result - 4], [0, 1], clamp);
  return (
    <Backdrop>
      <div style={{ position: "absolute", left: 90, top: 64 }}><Kicker color={C.primitive}>Primitive · every job is an email thread</Kicker></div>
      <Pop delay={6} style={{ position: "absolute", left: 90, top: 120, fontSize: 52, fontWeight: 800, letterSpacing: -1.5 }}>
        The email thread is the job&apos;s <span style={{ color: C.primitive }}>receipt</span>.
      </Pop>
      <div style={{ position: "absolute", right: 90, top: 76, fontFamily: mono, fontSize: 19, color: C.muted }}>REAL THREAD · fetched from Primitive&apos;s API</div>
      <div style={{ position: "absolute", left: 90, top: 200, width: 1090, display: "flex", flexDirection: "column", gap: 14 }}>
        <Mail delay={order} from="control@sli…" to="worker@sli…" time="11:14:15 UTC" subject="[mp:bc242633…:g1] index_video" rows={ORDER} />
        <Pop delay={work} style={{ borderRadius: 16, background: "#21190c", border: `1px solid ${C.worker}77`, padding: "14px 20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 24 }}>
            <span><b style={{ color: C.worker }}>Blaxel worker</b> · 4 GB sandbox · ffmpeg · whisper.cpp · vision</span>
            <span style={{ fontFamily: mono, color: C.muted }}>{(21.9 * bar).toFixed(1)} s</span>
          </div>
          <div style={{ height: 8, borderRadius: 4, background: "#3a2c14", marginTop: 10 }}><div style={{ height: "100%", width: `${bar * 100}%`, background: C.worker, borderRadius: 4 }} /></div>
        </Pop>
        <Mail delay={result} from="worker@sli…" to="control@sli…" time="11:14:41 UTC" subject="Re: [mp:bc242633…:g1] index_video" rows={RESULT} extra={<span style={{ color: C.primitive }}> · +25 s</span>} />
      </div>
      <div style={{ position: "absolute", left: 1220, top: 260, width: 610, display: "flex", flexDirection: "column", gap: 18 }}>
        <Badge delay={result + 8}>Signature <b>verified</b> on arrival</Badge>
        <Badge delay={at("primitive", 3)}><b>Deduplicated</b> by event ID — a retry can&apos;t run twice</Badge>
        <Badge delay={at("primitive", 3, 1.2)}><b>Retrievable</b> after the job via Primitive&apos;s email API</Badge>
      </div>
    </Backdrop>
  );
}

// 6 ─ Live search on the sample talk (real run; footage starts just before the CLI call)
export function Live({ frames }: P) {
  const f = useCurrentFrame();
  const RATE = 1.4, TRIM_S = 1.2, SPAWN_S = 1.5, DONE_S = 9.8;
  const elapsed = Math.max(0, TRIM_S + (f / 30) * RATE - SPAWN_S);
  const done = elapsed >= DONE_S;
  return (
    <Backdrop>
      <SpeedTag>LIVE RUN · {RATE}× · sample talk</SpeedTag>
      <Browser url="/app/jobs/d5df3fe7…" w={1600} style={{ left: 160, top: 50 }}>
        <Footage src="live.mp4" rate={RATE} from={Math.round(TRIM_S * 30)} w={1600} h={900} cam={[{ at: 0, x: 700, y: 800, s: 1.72 }]} />
        <div style={{ position: "absolute", right: 26, top: 22, fontFamily: mono, fontSize: 34, fontWeight: 700, padding: "10px 20px", borderRadius: 14,
          background: done ? C.lime : "rgba(10,10,11,.85)", color: done ? C.limeInk : C.text }}>
          {done ? `✓ answered in ${DONE_S} s` : `⏱ ${elapsed.toFixed(1)} s`}
        </div>
      </Browser>
      <Captions items={[
        [6, at("live", 1), "A new question on a recorded talk"],
        [at("live", 1) + 2, frames, <>Emailed to a worker · answer cites <Hi>0:10–0:21</Hi> · speech + visuals</>],
      ]} />
    </Backdrop>
  );
}

// 7 ─ The bug recording: cited answer, then the evidence
export function Bug({ frames }: P) {
  const split = at("bug", 2);
  const ra = 16.4 / ((split - 4) / 30), re = 13.1 / ((frames - split - 4) / 30);
  const k = (footageS: number) => Math.round((footageS / ra) * 30);
  return (
    <Backdrop>
      <Sequence durationInFrames={split}>
        <SpeedTag>{ra.toFixed(1)}× · LIVE SITE</SpeedTag>
        <Browser url="/app/jobs/bb641bda…" w={1600} style={{ left: 160, top: 50 }}>
          <Footage src="answer.mp4" rate={ra} w={1600} h={900}
            cam={[{ at: 0, x: 740, y: 545, s: 1.4 }, { at: k(4.9), x: 740, y: 545, s: 1.4 }, { at: k(6.9), x: 723, y: 580, s: 1.3 }]} />
        </Browser>
        <Captions items={[[6, at("bug", 1), "Bug recording: what changes after reload?"], [at("bug", 1) + 2, split, <>Saved as <Hi>60</Hi> → shows <Hi color={C.danger}>30</Hi> · cited <Hi>0:40–0:48</Hi></>]]} />
      </Sequence>
      <Sequence from={split}>
        <SpeedTag>{re.toFixed(1)}× · LIVE SITE</SpeedTag>
        <Browser url="/app/jobs/bb641bda…" w={1600} style={{ left: 160, top: 50 }} delay={0}>
          <Footage src="evidence.mp4" rate={re} w={1600} h={900} cam={[{ at: 0, x: 740, y: 420, s: 1.25 }, { at: 50, x: 740, y: 640, s: 1.2 }]} />
        </Browser>
        <Captions items={[[4, frames - split, <>Only the cited frames & clips · each <Hi>SHA-256</Hi> verified</>]]} />
      </Sequence>
    </Backdrop>
  );
}

// 8 ─ Index once, ask many times (measured: docs/efficiency-and-memory.md)
function Bar({ label, value, max, color, delay, unit }: { label: string; value: number; max: number; color: string; delay: number; unit: string }) {
  const f = useCurrentFrame();
  const p = interpolate(f, [delay, delay + 26], [0, 1], { ...clamp, easing: ease });
  return (
    <div style={{ marginBottom: 46 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
        <span style={{ fontSize: 40, fontWeight: 700 }}>{label}</span>
        <span style={{ fontFamily: mono, fontSize: 58, fontWeight: 700, color }}>{Math.round(value * p).toLocaleString("en-US")} <span style={{ fontSize: 26, color: C.muted }}>{unit}</span></span>
      </div>
      <div style={{ height: 32, borderRadius: 16, background: C.panel, border: `1px solid ${C.line}`, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${Math.max(0.7, (value / max) * 100) * p}%`, background: color, borderRadius: 16 }} />
      </div>
    </div>
  );
}
export function Memory(_: P) {
  const big = useIn(at("memory", 2, 1.4), 12);
  return (
    <Backdrop>
      <AbsoluteFill style={{ padding: "110px 200px", justifyContent: "center" }}>
        <Kicker>Index once · ask many times</Kicker>
        <div style={{ height: 50 }} />
        <Bar label="Index the video (once)" value={326710} max={326710} color={C.worker} delay={at("memory", 1)} unit="input tokens" />
        <Bar label="Each follow-up question" value={2507} max={326710} color={C.lime} delay={at("memory", 2)} unit="input tokens" />
        <div style={{ display: "flex", alignItems: "baseline", gap: 26, opacity: big, transform: `translateY(${(1 - big) * 20}px)` }}>
          <span style={{ fontSize: 130, fontWeight: 800, letterSpacing: -4, color: C.lime }}>~130×</span>
          <span style={{ fontSize: 46, fontWeight: 700 }}>less per question → <Hi>$0.50</Hi> answers work</span>
        </div>
        <div style={{ marginTop: 24, fontSize: 22, color: C.muted, fontFamily: mono, opacity: big }}>Measured input tokens from one recorded run · docs/efficiency-and-memory.md</div>
      </AbsoluteFill>
    </Backdrop>
  );
}

// 9 ─ Why every piece matters: the real architecture, one component lit at a time
const VALUE: { from: number; focus: NodeId[]; who: string; color: string; why: string }[] = [
  { from: 1, focus: ["stripe", "api", "agent"], who: "Stripe", color: C.stripe, why: "agents pay per use — no account, no keys" },
  { from: 2, focus: ["primitive", "api", "worker"], who: "Primitive", color: C.primitive, why: "an auditable email thread for every job" },
  { from: 3, focus: ["worker", "gateway", "api"], who: "Blaxel", color: C.worker, why: "an isolated sandbox per run that scales to zero" },
  { from: 4, focus: ["supabase", "api"], who: "Supabase", color: "#5fd39a", why: "allowance enforced inside Postgres" },
  { from: 5, focus: ["mcp", "agent", "api"], who: "Manufact", color: "#a9a3ff", why: "any agent plugs in over MCP" },
];
export function Value({ frames }: P) {
  const f = useCurrentFrame();
  const idx = VALUE.findLastIndex((v) => f >= at("value", v.from));
  const cur = idx >= 0 && f < frames - 26 ? VALUE[idx] : undefined;
  const k = interpolate(f, [0, 14], [0.94, 0.9], clamp);
  return (
    <AbsoluteFill style={{ background: C.bg, fontFamily: sans, color: C.text }}>
      <div style={{ position: "absolute", left: 0, top: 120, width: 1920, height: 1080, transform: `scale(${k})`, transformOrigin: "50% 0" }}>
        <Architecture theme="dark" focus={cur?.focus} title={false} />
      </div>
      <div style={{ position: "absolute", left: 90, top: 40, right: 90, display: "flex", alignItems: "baseline", gap: 22 }}>
        {cur ? (
          <>
            <span style={{ fontSize: 58, fontWeight: 800, color: cur.color }}>{cur.who}</span>
            <span style={{ fontSize: 46, fontWeight: 700, color: C.text }}>{cur.why}</span>
          </>
        ) : (
          <span style={{ fontSize: 58, fontWeight: 800 }}>Every piece earns its place</span>
        )}
      </div>
    </AbsoluteFill>
  );
}

// 10 ─ Close
export function Close(_: P) {
  const p = useIn(2, 13), q = useIn(at("close", 1)), r = useIn(at("close", 2));
  const chips = ["Stripe MPP (test mode)", "Primitive", "Blaxel", "Supabase", "MCP on Manufact"];
  return (
    <Backdrop>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", gap: 30 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 28, opacity: p, transform: `scale(${0.9 + 0.1 * p})` }}>
          <Logo size={120} /><div style={{ fontSize: 124, fontWeight: 800, letterSpacing: -4 }}>MediaPack</div>
        </div>
        <div style={{ fontSize: 48, fontWeight: 700, opacity: q, transform: `translateY(${(1 - q) * 14}px)` }}>
          <Hi>Searchable</Hi> · <Hi>payable</Hi> · <Hi>provable</Hi> video for agents.
        </div>
        <div style={{ display: "flex", gap: 12, opacity: q }}>
          {chips.map((c) => <span key={c} style={{ fontFamily: mono, fontSize: 22, padding: "8px 18px", borderRadius: 999, border: `1px solid ${C.line}`, background: C.panel }}>{c}</span>)}
        </div>
        <div style={{ marginTop: 26, display: "flex", flexDirection: "column", alignItems: "center", gap: 14, opacity: r, transform: `translateY(${(1 - r) * 16}px)` }}>
          <div style={{ fontFamily: mono, fontSize: 42, color: C.lime }}>mediapack-mediapack.preview.bl.run</div>
          <div style={{ fontFamily: mono, fontSize: 34, color: C.text }}>github.com/ankitshah009/mediapack</div>
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
}
