"use client";

import type { CSSProperties } from "react";
import type { FrameState } from "@/lib/types";

const NAV = ["General", "Connection", "Appearance", "Notifications", "Integrations"] as const;

const sans = "var(--font-inter), system-ui, sans-serif";
const mono = "var(--font-jetbrains), ui-monospace, monospace";

function UiFrame({ s }: { s: Extract<FrameState, { kind: "ui" }> }) {
  const active = s.page === "connection" ? "Connection" : "General";
  const dim: CSSProperties = { opacity: s.loading ? 0.35 : 1, transition: "opacity 120ms" };
  return (
    <div style={{ position: "absolute", inset: 0, background: "#ffffff", color: "#1c1d21", fontFamily: sans, display: "flex", flexDirection: "column" }}>
      {/* browser chrome */}
      <div style={{ height: "2.4em", flex: "none", background: "#eceef1", borderBottom: "0.06em solid #d9dce1", display: "flex", alignItems: "center", gap: "1em", padding: "0 1em" }}>
        <div style={{ display: "flex", gap: "0.45em" }}>
          {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
            <span key={c} style={{ width: "0.7em", height: "0.7em", borderRadius: "50%", background: c, display: "block" }} />
          ))}
        </div>
        <div style={{ flex: 1, maxWidth: "20em", margin: "0 auto", height: "1.35em", borderRadius: "999px", background: "#ffffff", border: "0.06em solid #d9dce1", display: "flex", alignItems: "center", padding: "0 0.8em", fontSize: "0.62em", color: "#5b6068", whiteSpace: "nowrap", overflow: "hidden" }}>
          app.example.com/settings
        </div>
        <div style={{ width: "3em" }} />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex", position: "relative" }}>
        {/* left nav */}
        <div style={{ ...dim, width: "9.5em", flex: "none", background: "#f6f7f9", borderRight: "0.06em solid #e3e5e9", padding: "1em 0.6em", display: "flex", flexDirection: "column", gap: "0.2em" }}>
          <div style={{ fontSize: "0.5em", letterSpacing: "0.08em", color: "#8a8f98", padding: "0 0.9em 0.8em", fontWeight: 600 }}>SETTINGS</div>
          {NAV.map((n) => (
            <div key={n} style={{ fontSize: "0.62em", padding: "0.55em 0.9em", borderRadius: "0.5em", fontWeight: n === active ? 600 : 400, background: n === active ? "#e3e8ff" : "transparent", color: n === active ? "#2b3fd1" : "#4a4f57", whiteSpace: "nowrap", overflow: "hidden" }}>
              {n}
            </div>
          ))}
        </div>
        {/* content */}
        <div style={{ ...dim, flex: 1, minWidth: 0, padding: "1.6em 2em", overflow: "hidden" }}>
          <div style={{ fontSize: "1em", fontWeight: 650, letterSpacing: "-0.01em" }}>{active === "Connection" ? "Connection settings" : "General"}</div>
          <div style={{ fontSize: "0.5em", color: "#8a8f98", marginTop: "0.5em" }}>
            {active === "Connection" ? "Control how the client talks to the server." : "Basic workspace preferences."}
          </div>
          {active === "Connection" ? (
            <div style={{ marginTop: "2em" }}>
              <div style={{ fontSize: "0.58em", fontWeight: 550, marginBottom: "0.6em" }}>Request timeout</div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.7em" }}>
                <div style={{ width: "7em", height: "1.9em", borderRadius: "0.4em", border: `0.1em solid ${s.typing ? "#3b5bfd" : "#c9ccd2"}`, display: "flex", alignItems: "center", padding: "0 0.7em", fontSize: "0.7em", fontFamily: mono, boxShadow: s.typing ? "0 0 0 0.25em rgb(59 91 253 / 0.15)" : "none" }}>
                  {s.value}
                  {s.typing && <span className="animate-pulse" style={{ width: "0.08em", height: "1.1em", background: "#1c1d21", marginLeft: "0.1em", display: "inline-block" }} />}
                </div>
                <span style={{ fontSize: "0.58em", color: "#5b6068" }}>seconds</span>
              </div>
              <div style={{ marginTop: "1.8em", display: "flex", alignItems: "center", gap: "0.7em" }}>
                {s.saved ? (
                  <div style={{ display: "flex", alignItems: "center", gap: "0.45em", color: "#16a34a", fontSize: "0.62em", fontWeight: 600 }}>
                    <span style={{ width: "1.5em", height: "1.5em", borderRadius: "50%", background: "#16a34a", color: "#fff", display: "grid", placeItems: "center", fontSize: "0.9em", lineHeight: 1 }}>✓</span>
                    Saved
                  </div>
                ) : (
                  <div style={{ fontSize: "0.62em", fontWeight: 600, color: "#fff", background: "#2f5bff", borderRadius: "0.5em", padding: "0.6em 1.4em" }}>Save</div>
                )}
              </div>
            </div>
          ) : (
            <div style={{ marginTop: "1.8em", display: "grid", gap: "1.1em", maxWidth: "16em" }}>
              {["Workspace name", "Language"].map((l, i) => (
                <div key={l}>
                  <div style={{ fontSize: "0.55em", fontWeight: 550, marginBottom: "0.5em" }}>{l}</div>
                  <div style={{ height: "1.8em", borderRadius: "0.4em", border: "0.1em solid #c9ccd2", fontSize: "0.65em", display: "flex", alignItems: "center", padding: "0 0.8em", color: "#4a4f57" }}>{i === 0 ? "Acme Inc." : "English (US)"}</div>
                </div>
              ))}
            </div>
          )}
        </div>
        {s.loading && (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
            <span className="animate-spin" style={{ width: "2em", height: "2em", borderRadius: "50%", border: "0.22em solid #d5d8de", borderTopColor: "#2f5bff", display: "block" }} />
          </div>
        )}
      </div>
    </div>
  );
}

function TalkFrame({ s }: { s: Extract<FrameState, { kind: "talk" }> }) {
  return (
    <div style={{ position: "absolute", inset: 0, background: "#14130f", color: "#f2f1ea", fontFamily: sans, display: "flex", flexDirection: "column" }}>
      <div style={{ flex: 1, minHeight: 0, padding: "2.4em 2.8em 0", overflow: "hidden" }}>
        <div style={{ width: "2.4em", height: "0.28em", background: "#d4f25a", borderRadius: "1em", marginBottom: "1em" }} />
        <div style={{ fontFamily: "var(--font-inter-tight), " + sans, fontSize: "1.9em", fontWeight: 650, letterSpacing: "-0.02em", lineHeight: 1.05 }}>{s.title}</div>
        <ul style={{ margin: "1.2em 0 0", padding: 0, listStyle: "none", display: "grid", gap: "0.55em" }}>
          {s.bullets.map((b) => (
            <li key={b} style={{ fontSize: "0.8em", color: "#cfcdc2", display: "flex", gap: "0.7em", alignItems: "baseline" }}>
              <span style={{ width: "0.4em", height: "0.4em", borderRadius: "50%", background: "#d4f25a", flex: "none", transform: "translateY(-0.1em)" }} />
              {b}
            </li>
          ))}
        </ul>
      </div>
      <div style={{ flex: "none", margin: "0 1.4em 1.2em", padding: "0.7em 1em", borderRadius: "0.6em", background: "rgb(0 0 0 / 0.62)", border: "0.06em solid rgb(255 255 255 / 0.08)" }}>
        <div style={{ fontSize: "0.45em", letterSpacing: "0.08em", textTransform: "uppercase", color: "#d4f25a", fontWeight: 600 }}>{s.speaker}</div>
        <div style={{ fontSize: "0.62em", marginTop: "0.25em", lineHeight: 1.3 }}>{s.caption}</div>
      </div>
    </div>
  );
}

export function Frame({ state, className }: { state: FrameState; className?: string }) {
  return (
    <div className={className} style={{ containerType: "inline-size", position: "relative", width: "100%", height: "100%", overflow: "hidden" }}>
      <div style={{ position: "absolute", inset: 0, fontSize: "2.4cqw" }}>
        {state.kind === "ui" ? <UiFrame s={state} /> : <TalkFrame s={state} />}
      </div>
    </div>
  );
}
