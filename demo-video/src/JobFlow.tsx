import { AbsoluteFill } from "remotion";
import { mono, sans } from "./theme";

// "One paid question, end to end" — README image (light) and video-friendly (dark).
const LANES = {
  Agent: { fill: "#e6f5a9", ink: "#1b2400" },
  Stripe: { fill: "#ebe9ff", ink: "#2a2470" },
  Postgres: { fill: "#e3f5ea", ink: "#12452a" },
  Primitive: { fill: "#dff4f2", ink: "#0b4f4a" },
  Blaxel: { fill: "#fdf0dc", ink: "#5c3a00" },
  API: { fill: "#1c211c", ink: "#f4f4f2" },
} as const;
type Lane = keyof typeof LANES;

const STEPS: { n: number; who: Lane[]; title: string; body: string }[] = [
  { n: 1, who: ["Agent", "API"], title: "Upload & verify", body: "Signed upload to private Storage; a worker probes the real file (ffprobe) before any quote." },
  { n: 2, who: ["Agent", "Stripe"], title: "Quote → HTTP 402 → pay", body: "$0.50 · 24 h · 3 searches · 8 frames · 15 s clips. Agent pays via Stripe MPP; PaymentIntent verified." },
  { n: 3, who: ["API", "Postgres"], title: "Reserve & write outbox", body: "Entitlement, allowance reservation and the outgoing message commit in one SQL transaction." },
  { n: 4, who: ["API", "Primitive"], title: "Email the work order", body: "control@ → worker@ with a stable idempotency key; retries resend the same payload." },
  { n: 5, who: ["Primitive", "Blaxel"], title: "Deliver → launch worker", body: "Signed webhook persists the event, then one 4 GB Blaxel sandbox starts for that operation." },
  { n: 6, who: ["Blaxel"], title: "Index the video", body: "ffmpeg frames + whisper.cpp speech + vision → a timestamped index and artifacts in Storage." },
  { n: 7, who: ["Blaxel", "Primitive", "API"], title: "Reply → verify → commit", body: "Result email back; signature, dedupe and generation checks before anything is committed." },
  { n: 8, who: ["Agent", "Postgres"], title: "Ask · cite · retrieve", body: "Answers cite exact seconds; frames/clips carry SHA-256; each use is charged in SQL." },
];

export function JobFlow({ theme = "light" }: { theme?: "light" | "dark" }) {
  const dark = theme === "dark";
  const bg = dark ? "#0a0a0b" : "#f6f4ee", card = dark ? "#141416" : "#ffffff", line = dark ? "#2a2a2e" : "#dedad0";
  const text = dark ? "#f4f4f2" : "#1d211d", muted = dark ? "#9a9a96" : "#5f655f";
  return (
    <AbsoluteFill style={{ background: bg, fontFamily: sans, color: text }}>
      <div style={{ position: "absolute", left: 70, top: 46 }}>
        <div style={{ fontSize: 50, fontWeight: 800, letterSpacing: -1.2 }}>One paid question, end to end</div>
        <div style={{ fontSize: 24, color: muted, marginTop: 4 }}>Every step is persisted before the next one runs — a crash resumes instead of repeating</div>
      </div>
      <div style={{ position: "absolute", left: 70, top: 170, width: 1780, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 26 }}>
        {STEPS.map((s) => (
          <div key={s.n} style={{ position: "relative", height: 380, boxSizing: "border-box", borderRadius: 20, background: card, border: `2px solid ${line}`, padding: "26px 26px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <span style={{ width: 52, height: 52, borderRadius: 26, background: text, color: bg, display: "grid", placeItems: "center", fontSize: 26, fontWeight: 800 }}>{s.n}</span>
              <span style={{ fontSize: 29, fontWeight: 800, lineHeight: 1.1 }}>{s.title}</span>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 20 }}>
              {s.who.map((w) => (
                <span key={w} style={{ fontFamily: mono, fontSize: 18, padding: "5px 12px", borderRadius: 999, background: LANES[w].fill, color: LANES[w].ink }}>{w === "API" ? "API · Blaxel" : w}</span>
              ))}
            </div>
            <div style={{ fontSize: 23, lineHeight: 1.45, color: muted, marginTop: 20 }}>{s.body}</div>
            {s.n % 4 !== 0 && <div style={{ position: "absolute", right: -22, top: 172, fontSize: 30, color: muted }}>→</div>}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
}
