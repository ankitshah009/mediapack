"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Scenario, Scripted } from "../scenario";
import type { JobEvent } from "../types";

/**
 * Replays a scenario's scripted events. Idempotent: each scripted step is delivered at most once,
 * so effect re-runs (StrictMode, Fast Refresh) never duplicate events.
 */
export function useDemoRun(sc: Scenario): { events: JobEvent[]; approving: boolean; approve: () => void } {
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [approving, setApproving] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const delivered = useRef(new Set<string>());
  const approved = useRef(false);

  const schedule = useCallback(
    (phase: "pre" | "post", script: Scripted[]) => {
      let acc = 0;
      script.forEach((step, i) => {
        const key = `${phase}-${i}`;
        acc += step.delay;
        if (delivered.current.has(key)) return;
        timers.current.push(
          setTimeout(() => {
            if (delivered.current.has(key)) return;
            delivered.current.add(key);
            setEvents((prev) => [
              ...prev,
              { ...step.event, id: prev.length + 1, job_id: sc.jobId, created_at: new Date().toISOString() } as JobEvent,
            ]);
          }, acc),
        );
      });
    },
    [sc.jobId],
  );

  useEffect(() => {
    schedule("pre", sc.prePay);
    if (approved.current) schedule("post", sc.postPay);
    const list = timers.current;
    return () => {
      list.forEach(clearTimeout);
      list.length = 0;
    };
  }, [sc, schedule]);

  const approve = useCallback(() => {
    if (approved.current) return;
    approved.current = true;
    setApproving(true);
    schedule("post", sc.postPay);
  }, [sc, schedule]);

  return { events, approving, approve };
}
