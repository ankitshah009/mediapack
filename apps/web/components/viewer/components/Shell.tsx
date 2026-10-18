import type { ReactNode } from "react";
import { ApiError, Api, ERROR_COPY } from "../api/client";
import { href, useRoute } from "../lib/router";
import NextLink from "next/link";
import { Badge, Button } from "./ui";
import { useState } from "react";

function Logo({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <rect x="2" y="2" width="14" height="14" rx="3" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <rect x="8" y="8" width="14" height="14" rx="3" fill="#d4f25a" />
    </svg>
  );
}

const NAV = [
  { label: "Videos", path: "/", match: ["videos", "video", "job"] },
  { label: "Pair with agent", path: "/pair", match: ["pair"] },
];

function Link({ to, children, className, ...rest }: { to: string; children: ReactNode; className?: string } & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <NextLink
      href={href(to)}
      className={className}
      {...rest}
    >
      {children}
    </NextLink>
  );
}
export { Link };

export function Shell({
  crumb,
  badges,
  children,
  aside,
}: {
  crumb?: ReactNode;
  badges?: ReactNode;
  children: ReactNode;
  aside?: ReactNode;
}) {
  const route = useRoute();
  return (
    <div className="flex min-h-dvh flex-col bg-paper text-text md:flex-row">
      <nav aria-label="Primary" className="rail hidden w-16 shrink-0 flex-col items-center gap-2 bg-rail py-4 text-rail-text md:flex">
        <Link to="/" aria-label="MediaPack home" className="mb-4 grid h-10 w-10 place-items-center">
          <Logo />
        </Link>
        <ul className="flex flex-col items-center gap-1">
          {NAV.map((n) => {
            const on = n.match.includes(route.name);
            return (
              <li key={n.path} className="group relative">
                <Link
                  to={n.path}
                  aria-label={n.label}
                  aria-current={on ? "page" : undefined}
                  className={`relative grid h-10 w-10 place-items-center rounded-xl text-xs font-semibold ${on ? "bg-white/10 text-white" : "text-rail-text/60 hover:bg-white/5 hover:text-white"}`}
                >
                  {on && <span className="absolute -left-3 top-2 h-6 w-[3px] rounded-r bg-lime" />}
                  {n.path === "/" ? (
                    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m10 9 5 3-5 3z" fill="currentColor" /></svg>
                  ) : (
                    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></svg>
                  )}
                </Link>
                <span role="tooltip" className="pointer-events-none absolute left-full top-1/2 z-50 ml-3 -translate-y-1/2 whitespace-nowrap rounded-md bg-ink px-2 py-1 text-xs text-white opacity-0 shadow-lg ring-1 ring-white/10 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                  {n.label}
                </span>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="rail sticky top-0 z-40 flex flex-wrap items-center gap-x-3 gap-y-1 bg-rail px-3 py-2.5 text-rail-text sm:px-5 md:static">
          <Link to="/" className="flex items-center gap-2 md:hidden" aria-label="MediaPack home">
            <Logo className="h-6 w-6" />
          </Link>
          <div className="flex min-w-0 flex-col leading-tight">
            <div className="flex items-center gap-2">
              <span className="font-display text-sm font-semibold tracking-tight text-white">MediaPack</span>
              <Badge tone="lime">Stripe test mode</Badge>
            </div>
            <span className="hidden text-[11px] text-rail-text/70 sm:block">Video search and retrieval for agents</span>
          </div>
          {crumb && <div className="hidden min-w-0 items-center gap-1 border-l border-white/10 pl-3 font-mono text-xs text-rail-text/70 lg:flex">{crumb}</div>}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {badges}
            <nav aria-label="Primary (mobile)" className="flex gap-1 md:hidden">
              <Link to="/" className="rounded-lg px-2 py-1 text-xs text-white hover:bg-white/10">Videos</Link>
              <Link to="/pair" className="rounded-lg px-2 py-1 text-xs text-white hover:bg-white/10">Pair</Link>
            </nav>
          </div>
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px]">
          <main className="min-w-0 px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
            <div className="mx-auto flex max-w-4xl flex-col gap-6">{children}</div>
          </main>
          {aside && (
            <aside aria-label="Activity, allowance and receipt" className="min-w-0 border-t border-line px-4 py-5 sm:px-6 lg:border-l lg:border-t-0 lg:px-5 lg:py-7">
              <div className="flex flex-col gap-6">{aside}</div>
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}

export function SessionPrompt({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  return (
    <div className="rounded-2xl border border-line bg-card p-5" role="alert">
      <h2 className="font-display text-lg font-semibold">Start a browser session</h2>
      <p className="mt-1 text-sm text-muted">
        This browser has no MediaPack client yet. Start a new one to upload and buy your own videos, or pair with an
        agent to watch the videos it owns.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          variant="primary"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            setErr(undefined);
            try {
              await Api.bootstrap();
              onDone();
            } catch (e) {
              setErr(e instanceof ApiError ? e.message : "Could not start a session.");
            } finally {
              setBusy(false);
            }
          }}
        >
          Start new session
        </Button>
        <Link to="/pair" className="inline-flex min-h-10 items-center rounded-xl border border-line px-4 text-sm font-medium hover:bg-line">
          Pair with an agent
        </Link>
      </div>
      {err && <p className="mt-3 text-sm text-danger">{err}</p>}
    </div>
  );
}

/** Code-specific friendly error state. */
export function ErrorPanel({ error, onRetry, onSession }: { error: ApiError; onRetry?: () => void; onSession?: () => void }) {
  if (error.code === "UNAUTHORIZED" && onSession) return <SessionPrompt onDone={onSession} />;
  const copy = ERROR_COPY[error.code] ?? ERROR_COPY.INTERNAL;
  const reconciling = error.code === "PAYMENT_RECONCILING";
  return (
    <div role="alert" className={`rounded-2xl border p-4 ${reconciling ? "border-stripe/40 bg-stripe-soft" : "border-danger/30 bg-danger-soft"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-display text-sm font-semibold">{copy.title}</h3>
        <Badge tone={reconciling ? "stripe" : "danger"}>{error.code}</Badge>
      </div>
      <p className="mt-1 text-sm">{error.message}</p>
      <p className="mt-1 text-sm text-muted">{error.nextAction ?? copy.hint}</p>
      {error.retryAfter ? <p className="mt-1 text-xs text-muted">Retry after about {error.retryAfter}s.</p> : null}
      {onRetry && (error.retryable || error.code === "NETWORK") && (
        <Button className="mt-3" onClick={onRetry}>Retry</Button>
      )}
    </div>
  );
}
