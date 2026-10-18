import type { ReactNode } from "react";
import { AbsoluteFill } from "remotion";
import { mono, sans } from "./theme";

// One source for the README image and the video scene. Coordinates are on a 1920x1080 canvas.
export type NodeId = "agent" | "mcp" | "browser" | "api" | "stripe" | "supabase" | "primitive" | "worker" | "gateway" | "notes";

type Theme = { bg: string; card: string; line: string; text: string; muted: string; edge: string; label: string };
const LIGHT: Theme = { bg: "#f6f4ee", card: "#ffffff", line: "#dedad0", text: "#1d211d", muted: "#5f655f", edge: "#566056", label: "#3d443d" };
const DARK: Theme = { bg: "#0a0a0b", card: "#141416", line: "#2a2a2e", text: "#f4f4f2", muted: "#9a9a96", edge: "#7c837c", label: "#b9beb9" };

const ACCENT: Record<NodeId, { fill: string; ink: string; border: string; darkInk?: string }> = {
  agent: { fill: "#e6f5a9", ink: "#1b2400", border: "#c9e36a" },
  mcp: { fill: "#e8e6ff", ink: "#26205f", border: "#bdb7ff" },
  browser: { fill: "#ffffff", ink: "#1d211d", border: "#dedad0" },
  api: { fill: "#1c211c", ink: "#f4f4f2", border: "#1c211c" },
  stripe: { fill: "#ebe9ff", ink: "#2a2470", border: "#b8b2ff" },
  supabase: { fill: "#e3f5ea", ink: "#12452a", border: "#9fd9b6" },
  primitive: { fill: "#dff4f2", ink: "#0b4f4a", border: "#8fd5ce" },
  worker: { fill: "#fdf0dc", ink: "#5c3a00", border: "#efc77e" },
  gateway: { fill: "#fff7ea", ink: "#5c3a00", border: "#efd7a8" },
  notes: { fill: "transparent", ink: "#1d211d", border: "#dedad0" },
};

export const BOXES: Record<NodeId, { x: number; y: number; w: number; h: number }> = {
  agent: { x: 70, y: 170, w: 460, h: 130 },
  mcp: { x: 640, y: 170, w: 470, h: 130 },
  browser: { x: 1400, y: 170, w: 450, h: 130 },
  stripe: { x: 70, y: 390, w: 460, h: 178 },
  api: { x: 640, y: 390, w: 600, h: 150 },
  supabase: { x: 1400, y: 390, w: 450, h: 250 },
  primitive: { x: 640, y: 640, w: 600, h: 130 },
  worker: { x: 640, y: 860, w: 600, h: 140 },
  gateway: { x: 1400, y: 860, w: 450, h: 140 },
  notes: { x: 70, y: 640, w: 460, h: 360 },
};

function Box({ id, title, lines, t, dim, glow }: { id: NodeId; title: string; lines: ReactNode[]; t: Theme; dim: boolean; glow: boolean }) {
  const b = BOXES[id], a = ACCENT[id];
  const dark = t === DARK;
  const fill = dark ? (id === "api" ? "#f4f4f2" : t.card) : a.fill;
  const ink = dark ? (id === "api" ? "#111" : t.text) : a.ink;
  const border = dark ? a.border : a.border;
  return (
    <div style={{
      position: "absolute", left: b.x, top: b.y, width: b.w, height: b.h, boxSizing: "border-box", borderRadius: 18,
      background: fill, border: `2px solid ${glow ? a.border : dark ? t.line : border}`, padding: "20px 26px",
      opacity: dim ? 0.28 : 1, boxShadow: glow ? `0 0 0 6px ${a.border}55, 0 24px 60px ${a.border}44` : dark ? "none" : "0 1px 0 rgba(0,0,0,.04)",
      transition: "none",
    }}>
      <div style={{ fontFamily: sans, fontWeight: 800, fontSize: 25, letterSpacing: 1.2, color: dark && id !== "api" ? a.border : ink }}>{title}</div>
      {lines.map((l, i) => (
        <div key={i} style={{ fontFamily: sans, fontSize: 21, lineHeight: 1.45, marginTop: i === 0 ? 10 : 2, color: dark && id !== "api" ? t.muted : ink, opacity: dark ? 1 : 0.86 }}>{l}</div>
      ))}
    </div>
  );
}

type Edge = { d: string; label?: string; lx?: number; ly?: number; dashed?: boolean; both?: boolean; on?: NodeId[] };
const EDGES: Edge[] = [
  { d: "M530 235 H632", label: "MCP", lx: 548, ly: 222, on: ["agent", "mcp"] },
  { d: "M875 300 V382", label: "forwards caller capability", lx: 890, ly: 348, on: ["mcp", "api"] },
  { d: "M300 300 V340 H700 V382", label: "REST /v1 (CLI)", lx: 330, ly: 330, on: ["agent", "api"] },
  { d: "M1625 300 V340 H1180 V382", label: "same job, live", lx: 1450, ly: 330, on: ["browser", "api"] },
  { d: "M638 465 H538", label: "402 · pay", lx: 546, ly: 452, both: true, on: ["stripe", "api"] },
  { d: "M1242 430 H1392", label: "state · URLs", lx: 1254, ly: 418, on: ["api", "supabase"] },
  { d: "M1398 505 H1248", label: "recovery tick", lx: 1258, ly: 530, dashed: true, on: ["supabase", "api"] },
  { d: "M800 540 V632", label: "work order (email)", lx: 814, ly: 592, on: ["api", "primitive"] },
  { d: "M1080 632 V548", label: "signed webhooks", lx: 1094, ly: 592, on: ["primitive", "api"] },
  { d: "M640 520 H590 V930 H632", label: "launch after delivery", lx: 604, ly: 820, on: ["api", "worker"] },
  { d: "M940 860 V778", label: "result reply (email)", lx: 954, ly: 824, on: ["worker", "primitive"] },
  { d: "M1240 890 H1340 V600 H1392", label: "source · artifacts", lx: 1352, ly: 704, on: ["worker", "supabase"] },
  { d: "M1242 960 H1392", label: "vision", lx: 1292, ly: 948, on: ["worker", "gateway"] },
];

export function Architecture({ theme = "light", focus, title = true }: { theme?: "light" | "dark"; focus?: NodeId[]; title?: boolean }) {
  const t = theme === "dark" ? DARK : LIGHT;
  const isOn = (id: NodeId) => !focus || focus.includes(id);
  const edgeOn = (e: Edge) => !focus || (e.on ?? []).every((n) => focus.includes(n));
  return (
    <AbsoluteFill style={{ background: t.bg, color: t.text, fontFamily: sans }}>
      {title && (
        <div style={{ position: "absolute", left: 70, top: 46 }}>
          <div style={{ fontSize: 50, fontWeight: 800, letterSpacing: -1.2 }}>MediaPack architecture</div>
          <div style={{ fontSize: 24, color: t.muted, marginTop: 4 }}>Paid, verifiable video search for agents · live at mediapack-mediapack.preview.bl.run</div>
        </div>
      )}
      <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }}>
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill={t.edge} />
          </marker>
        </defs>
        {EDGES.map((e, i) => (
          <g key={i} opacity={edgeOn(e) ? 1 : 0.15}>
            <path d={e.d} fill="none" stroke={t.edge} strokeWidth={3} strokeDasharray={e.dashed ? "9 8" : undefined}
              markerEnd="url(#arrow)" markerStart={e.both ? "url(#arrow)" : undefined} />
            {e.label && <text x={e.lx} y={e.ly} fontFamily={sans} fontSize={19} fill={t.label}>{e.label}</text>}
          </g>
        ))}
      </svg>
      <Box id="agent" t={t} dim={!isOn("agent")} glow={!!focus && isOn("agent")} title="AGENT CLIENT" lines={["CLI · Claude · any MCP client", "upload · pay · search · retrieve"]} />
      <Box id="mcp" t={t} dim={!isOn("mcp")} glow={!!focus && isOn("mcp")} title="MCP ON MANUFACT" lines={["mcp-use proxy · 9 tools", "no provider secrets inside"]} />
      <Box id="browser" t={t} dim={!isOn("browser")} glow={!!focus && isOn("browser")} title="BROWSER DASHBOARD" lines={["React viewer, paired to the agent", "renders only persisted events"]} />
      <Box id="stripe" t={t} dim={!isOn("stripe")} glow={!!focus && isOn("stripe")} title="STRIPE MPP · TEST MODE" lines={["HTTP 402 price → agent pays", "PaymentIntent verified server-side", "idempotent on quote_id"]} />
      <Box id="api" t={t} dim={!isOn("api")} glow={!!focus && isOn("api")} title="API · NEXT.JS ON BLAXEL" lines={["REST /v1 · dashboard · webhooks · /internal/tick", <span key="u" style={{ fontFamily: mono, fontSize: 19 }}>stable preview URL · standby when idle</span>]} />
      <Box id="supabase" t={t} dim={!isOn("supabase")} glow={!!focus && isOn("supabase")} title="SUPABASE" lines={["Postgres: jobs · payments · outbox · events", "allowance enforced in SQL", "Storage: private videos · indexes · artifacts", "pg_cron: idle-aware recovery"]} />
      <Box id="primitive" t={t} dim={!isOn("primitive")} glow={!!focus && isOn("primitive")} title="PRIMITIVE · EMAIL TRANSPORT" lines={["work order control@ → worker@ · result reply back", "signed · deduplicated · retrievable thread per job"]} />
      <Box id="worker" t={t} dim={!isOn("worker")} glow={!!focus && isOn("worker")} title="BLAXEL WORKER · ONE PER OPERATION" lines={["4 GB sandbox · ffmpeg · whisper.cpp speech", "frames · clips · timestamped index"]} />
      <Box id="gateway" t={t} dim={!isOn("gateway")} glow={!!focus && isOn("gateway")} title="BLAXEL MODEL GATEWAY" lines={["vision model", "short-lived token per launch"]} />
      <Box id="notes" t={t} dim={!isOn("notes")} glow={false} title="GUARANTEES" lines={[
        "• One charge per quote (idempotent)",
        "• Allowance can't be overspent (SQL)",
        "• Outbox before send; webhooks deduped",
        "• Crash or standby → recovery resumes",
        "• Answers cite exact seconds",
        "• Frames & clips carry SHA-256",
      ]} />
    </AbsoluteFill>
  );
}
