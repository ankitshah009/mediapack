/** Video time (position inside the media) — never mix with runtime time. */
export function mmss(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
export function range(startMs: number, endMs: number): string {
  return `${mmss(startMs)}–${mmss(endMs)}`;
}
export function bytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
export function money(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}
export function dur(ms: number | null | undefined): string {
  return ms == null ? "—" : mmss(ms);
}
export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s`;
}
export function shortHash(h: string | null | undefined, n = 10): string {
  return h ? h.slice(0, n) : "—";
}
/** Runtime clock time (local). */
export function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString(undefined, { hour12: false });
}
/** Runtime offset from a reference instant, e.g. "+12.4s", "+3m 05s". */
export function offset(iso: string, fromIso: string): string {
  const ms = new Date(iso).getTime() - new Date(fromIso).getTime();
  if (Number.isNaN(ms)) return "";
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `+${s.toFixed(1)}s`;
  return `+${Math.floor(s / 60)}m ${String(Math.floor(s % 60)).padStart(2, "0")}s`;
}
export function countdown(iso: string, now: number): { text: string; expired: boolean } {
  const ms = new Date(iso).getTime() - now;
  if (Number.isNaN(ms)) return { text: iso, expired: false };
  if (ms <= 0) return { text: "expired", expired: true };
  const s = Math.floor(ms / 1000);
  if (s < 3600) return { text: `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s left`, expired: false };
  return { text: `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m left`, expired: false };
}
export function uuid(): string {
  return crypto.randomUUID();
}

/** Parse "m:ss", "mm:ss" or plain seconds into ms. Returns null when invalid. */
export function parseTime(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const m = /^(\d+):([0-5]?\d)(?:\.(\d{1,3}))?$/.exec(t);
  if (m) return (Number(m[1]) * 60 + Number(m[2])) * 1000 + (m[3] ? Number(m[3].padEnd(3, "0")) : 0);
  const n = /^\d+(?:\.\d+)?$/.test(t) ? Number(t) : NaN;
  return Number.isFinite(n) ? Math.round(n * 1000) : null;
}

const pending = new Map<string, string>();
/** Same payload -> same request_id until it succeeds, so a retried click is idempotent server-side. */
export function requestIdFor(payloadKey: string): string {
  let id = pending.get(payloadKey);
  if (!id) pending.set(payloadKey, (id = crypto.randomUUID()));
  return id;
}
export function settleRequest(payloadKey: string) {
  pending.delete(payloadKey);
}
