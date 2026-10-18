import { useRef, useState } from "react";
import { Api, ApiError, uploadFile } from "../api/client";
import { toApiError } from "../api/hooks";
import { bytes } from "../lib/format";
import { INPUT, preflight } from "../lib/limits";
import { useNavigate } from "../lib/router";
import { Button, Spinner } from "./ui";

type Phase =
  | { k: "idle" }
  | { k: "creating"; file: File }
  | { k: "uploading"; file: File; loaded: number; total: number }
  | { k: "completing"; file: File }
  | { k: "error"; file?: File; message: string; code?: string };

export function Uploader({ onUploaded }: { onUploaded?: () => void }) {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const ctl = useRef<AbortController | null>(null);
  const reqIds = useRef(new Map<string, string>());
  const busy = phase.k === "creating" || phase.k === "uploading" || phase.k === "completing";

  async function start(file: File) {
    const reject = preflight(file);
    if (reject) return setPhase({ k: "error", file, message: reject, code: "PREFLIGHT" });
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    const rid = reqIds.current.get(key) ?? crypto.randomUUID();
    reqIds.current.set(key, rid);
    ctl.current = new AbortController();
    try {
      setPhase({ k: "creating", file });
      const created = await Api.createVideo({
        request_id: rid,
        file_name: file.name,
        size_bytes: file.size,
        content_type: file.type,
      });
      // An idempotent retry can return an already completed video with no upload URL.
      if (created.upload) {
        setPhase({ k: "uploading", file, loaded: 0, total: file.size });
        await uploadFile(created.upload, file, (loaded, total) => setPhase({ k: "uploading", file, loaded, total }), ctl.current.signal);
      }
      setPhase({ k: "completing", file });
      await Api.completeVideo(created.video_id, rid);
      reqIds.current.delete(key);
      onUploaded?.();
      navigate(`/v/${created.video_id}`);
      setPhase({ k: "idle" });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return setPhase({ k: "idle" });
      const err = toApiError(e);
      setPhase({ k: "error", file, message: err.message, code: err.code });
    }
  }

  const pct = phase.k === "uploading" ? Math.round((phase.loaded / Math.max(1, phase.total)) * 100) : 0;

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!busy) setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const f = e.dataTransfer.files[0];
        if (f && !busy) void start(f);
      }}
      className={`rounded-2xl border-2 border-dashed p-5 transition-colors sm:p-7 ${drag ? "border-stripe bg-stripe-soft" : "border-line bg-card"}`}
    >
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-display text-lg font-semibold tracking-tight">Upload a video to search</h2>
          <p className="mt-1 text-sm text-muted">
            Drop an MP4 or WebM here. Up to {bytes(INPUT.maxBytes)}, 3 minutes, 1920×1080. Verified after upload before
            it can be bought.
          </p>
        </div>
        <div className="shrink-0">
          <input
            ref={input}
            id="video-file"
            type="file"
            accept={INPUT.contentTypes.join(",")}
            aria-label="Choose video"
            hidden
            tabIndex={-1}
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void start(f);
            }}
          />
          <Button variant="primary" disabled={busy} onClick={() => input.current?.click()}>
            Choose video
          </Button>
        </div>
      </div>

      {busy && (
        <div className="mt-4" role="status" aria-live="polite">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              <Spinner />
              <span className="truncate">
                {phase.k === "creating" && "Requesting upload slot…"}
                {phase.k === "uploading" && `Uploading ${phase.file.name}`}
                {phase.k === "completing" && "Finalizing — checking the file arrived…"}
              </span>
            </span>
            {phase.k === "uploading" && (
              <span className="font-mono text-xs">
                {bytes(phase.loaded)} / {bytes(phase.total)} · {pct}%
              </span>
            )}
          </div>
          {phase.k === "uploading" && (
            <div
              role="progressbar"
              aria-label="Upload progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              className="mt-2 h-2 overflow-hidden rounded-full bg-line"
            >
              <div className="h-full bg-lime transition-[width]" style={{ width: `${pct}%` }} />
            </div>
          )}
          {phase.k === "uploading" && (
            <Button className="mt-3" variant="ghost" onClick={() => ctl.current?.abort()}>
              Cancel upload
            </Button>
          )}
        </div>
      )}

      {phase.k === "error" && (
        <div role="alert" className="mt-4 rounded-xl border border-danger/30 bg-danger-soft p-3 text-sm">
          <p className="font-medium text-danger">{phase.code === "PREFLIGHT" ? "Can't upload this file" : "Upload failed"}</p>
          <p className="mt-0.5">{phase.message}</p>
          {phase.file && phase.code !== "PREFLIGHT" && (
            <Button className="mt-2" onClick={() => void start(phase.file!)}>
              Retry same upload
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export type { ApiError };
