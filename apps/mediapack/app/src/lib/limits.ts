// Client-side preflight mirror of INPUT_LIMITS / PACK in src/contracts (values duplicated on purpose: that module
// imports node:crypto and must not enter the browser bundle). The server remains authoritative and re-validates.
export const INPUT = {
  maxBytes: 50 * 1024 * 1024,
  maxDurationMs: 180_000,
  maxLongEdge: 1920,
  maxShortEdge: 1080,
  contentTypes: ["video/mp4", "video/webm"],
} as const;
export const CLIP_MAX_MS = 15_000;
export const FRAMES_MAX = 8;

export function preflight(file: File): string | null {
  if (!(INPUT.contentTypes as readonly string[]).includes(file.type)) {
    return `Unsupported type "${file.type || "unknown"}". Use MP4 or WebM.`;
  }
  if (file.size <= 0) return "File is empty.";
  if (file.size > INPUT.maxBytes) return `File is ${(file.size / 1024 ** 2).toFixed(1)} MB; the limit is ${INPUT.maxBytes / 1024 ** 2} MB.`;
  return null;
}
