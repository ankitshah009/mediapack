"use client";

import { Check } from "lucide-react";
import { rel } from "@/lib/format";
import { STEPS, type JobView, type Step } from "@/lib/reduce";

const LABEL: Record<Step, { name: string; provider: string }> = {
  quote: { name: "Quote", provider: "MediaPack" },
  paid: { name: "Paid", provider: "Stripe" },
  dispatched: { name: "Dispatched", provider: "Primitive" },
  indexed: { name: "Indexed", provider: "Blaxel" },
  retrieved: { name: "Retrieved", provider: "Agent" },
  delivered: { name: "Delivered", provider: "Primitive" },
};

export function Pipeline({ view }: { view: JobView }) {
  const done = (s: Step) => Boolean(view.steps[s]);
  const activeStep: Step | undefined = view.phase === "quoted" ? undefined : STEPS.find((s) => !done(s));

  return (
    <ol aria-label="Job pipeline" className="flex w-full items-start rounded-2xl border border-line bg-card px-2 py-4 sm:px-5">
      {STEPS.map((step, i) => {
        const isDone = done(step);
        const isActive = step === activeStep;
        const prevDone = i > 0 && done(STEPS[i - 1]);
        const { name, provider } = LABEL[step];
        const at = view.steps[step];
        const base = view.steps.quote;
        return (
          <li
            key={step}
            aria-current={isActive ? "step" : undefined}
            className="relative flex min-w-0 flex-1 flex-col items-center text-center"
          >
            {i > 0 && (
              <span
                aria-hidden="true"
                className={`absolute right-1/2 top-[11px] h-0.5 w-full transition-colors duration-500 ${
                  prevDone && (isDone || isActive) ? "bg-lime" : "bg-line"
                }`}
              />
            )}
            <span
              className={`relative z-10 grid h-6 w-6 place-items-center rounded-full border-2 transition-colors ${
                isDone
                  ? "border-lime bg-lime text-lime-ink"
                  : isActive
                    ? "border-lime bg-card"
                    : "border-muted/40 bg-card"
              }`}
            >
              {isDone && <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden="true" />}
              {isActive && (
                <span className="absolute -inset-1 animate-ping rounded-full border-2 border-lime/70" aria-hidden="true" />
              )}
            </span>
            <span className={`mt-2 block max-w-full truncate text-[11px] font-medium sm:text-xs ${isDone || isActive ? "text-text" : "text-muted"}`}>
              <span className="hidden sm:inline">{name} · </span>
              {provider}
            </span>
            <span className="mt-0.5 block font-mono text-[10px] text-muted sm:text-[11px]">
              {isDone && at && base ? rel(base, at) : isActive ? "working…" : "—"}
            </span>
            <span className="sr-only">
              {name}, {isDone ? "done" : isActive ? "in progress" : "pending"}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
