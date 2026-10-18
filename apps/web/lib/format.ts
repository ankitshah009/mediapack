export function ts(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
export const num = (x: number) => x.toLocaleString("en-US");
export const secs = (ms: number) => `${Math.round(ms / 1000)}s`;

/** "+1.4s" relative to a base ISO time. */
export function rel(baseIso: string, iso: string): string {
  const d = (Date.parse(iso) - Date.parse(baseIso)) / 1000;
  return `+${d.toFixed(1)}s`;
}
