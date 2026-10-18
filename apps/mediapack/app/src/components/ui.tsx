import type { ButtonHTMLAttributes, ReactNode } from "react";

type Tone = "neutral" | "lime" | "stripe" | "danger" | "ok" | "warn" | "primitive";
const TONES: Record<Tone, string> = {
  neutral: "bg-line text-text",
  lime: "bg-lime text-lime-ink",
  stripe: "bg-stripe-soft text-stripe",
  danger: "bg-danger-soft text-danger",
  ok: "bg-ok-soft text-ok",
  warn: "bg-worker/15 text-worker",
  primitive: "bg-primitive/15 text-primitive",
};

export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-5 ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export function Card({ children, className = "", ...rest }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLElement>) {
  return (
    <section className={`rounded-2xl border border-line bg-card p-4 sm:p-5 ${className}`} {...rest}>
      {children}
    </section>
  );
}

export function SectionTitle({ children, aside, id }: { children: ReactNode; aside?: ReactNode; id?: string }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 id={id} className="font-display text-base font-semibold tracking-tight">
        {children}
      </h2>
      {aside}
    </div>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost"; busy?: boolean };
export function Button({ variant = "secondary", busy, className = "", children, disabled, ...rest }: BtnProps) {
  const base =
    "inline-flex min-h-10 items-center justify-center gap-2 rounded-xl px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";
  const v =
    variant === "primary"
      ? "bg-lime text-lime-ink hover:brightness-95 on-lime"
      : variant === "secondary"
        ? "border border-line bg-card text-text hover:bg-line"
        : "text-muted hover:bg-line hover:text-text";
  return (
    <button type="button" disabled={disabled || busy} aria-busy={busy || undefined} className={`${base} ${v} ${className}`} {...rest}>
      {busy && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={`${className} animate-spin`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Skeleton({ className = "h-4 w-full" }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded-md bg-line ${className}`} />;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line px-4 py-8 text-center">
      <p className="font-display text-sm font-semibold">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-muted">{children}</div>}
    </div>
  );
}

export function Mono({ children, className = "", title }: { children: ReactNode; className?: string; title?: string }) {
  return <span title={title} className={`font-mono text-[12px] break-all ${className}`}>{children}</span>;
}

export function Meter({ label, used, reserved = 0, total, unit }: { label: string; used: number; reserved?: number; total: number; unit?: string }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const rpct = total > 0 ? Math.min(100 - pct, (reserved / total) * 100) : 0;
  const left = Math.max(0, total - used - reserved);
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-muted">{label}</span>
        <span className="font-mono">
          {used}
          {reserved ? <span className="text-worker">+{reserved}</span> : null} / {total}
          {unit}
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={used}
        aria-valuetext={`${used} used, ${reserved} reserved, ${left} left of ${total}${unit ?? ""}`}
        className="mt-1 flex h-1.5 overflow-hidden rounded-full bg-line"
      >
        <div className="bg-lime" style={{ width: `${pct}%` }} />
        <div className="bg-worker/60" style={{ width: `${rpct}%` }} />
      </div>
    </div>
  );
}
