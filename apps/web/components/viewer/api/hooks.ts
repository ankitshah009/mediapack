import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { Api, ApiError, type JobEvent, type JobView } from "./client";

export function toApiError(e: unknown): ApiError {
  return e instanceof ApiError ? e : new ApiError(0, "INTERNAL", e instanceof Error ? e.message : "Unexpected error");
}

/**
 * Real polling of a real endpoint: repeats while `active(data)` is true, with exponential backoff on errors,
 * pausing while the tab is hidden. Not a simulated timer — every tick is a GET.
 */
export function usePoll<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  active: (d: T) => boolean,
  deps: unknown[],
  baseMs = 1500,
) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fetchCurrent = useEffectEvent((signal: AbortSignal) => fn(signal));
  const shouldContinue = useEffectEvent((value: T) => active(value));
  useEffect(() => {
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fails = 0;
    const run = async () => {
      if (ctl.signal.aborted) return;
      if (document.hidden) {
        timer = setTimeout(run, 1000);
        return;
      }
      let continuePolling = true;
      try {
        const d = await fetchCurrent(ctl.signal);
        if (ctl.signal.aborted) return;
        fails = 0;
        setData(d);
        setError(undefined);
        continuePolling = shouldContinue(d);
      } catch (e) {
        if (ctl.signal.aborted) return;
        fails++;
        const err = toApiError(e);
        setError(err);
        continuePolling = err.retryable || err.code === "NETWORK";
      } finally {
        if (!ctl.signal.aborted) setLoading(false);
      }
      if (continuePolling && !ctl.signal.aborted) {
        timer = setTimeout(run, Math.min(15_000, baseMs * 2 ** Math.min(fails, 4)));
      }
    };
    void run();
    return () => {
      ctl.abort();
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, loading, reload: useCallback(() => setTick((t) => t + 1), []) };
}

export const jobActive = (j: JobView) =>
  j.payment_state === "reconciling" ||
  j.state === "awaiting_payment" ||
  j.state === "paid" ||
  j.state === "indexing" ||
  j.state === "ready" || // A paired agent can submit new operations after the index becomes ready.
  j.operations.some((o) => o.state === "queued" || o.state === "dispatched" || o.state === "running");

/** Job + incremental events (cursor = last event id), fetched together on every poll tick. */
export function useJob(jobId: string, nonce = 0) {
  const [eventState, setEvents] = useState<{ jobId: string; rows: JobEvent[] }>({ jobId, rows: [] });
  const [evError, setEvError] = useState<ApiError>();
  const cursor = useRef(0);
  useEffect(() => {
    cursor.current = 0;
  }, [jobId]);
  const job = usePoll(
    async (signal) => {
      const j = await Api.job(jobId, signal);
      try {
        const rows = await Api.events(jobId, cursor.current, signal);
        if (!signal.aborted && rows.length) {
          cursor.current = Math.max(cursor.current, ...rows.map((r) => r.id));
          setEvents((state) => {
            const prev = state.jobId === jobId ? state.rows : [];
            const seen = new Set(prev.map((p) => p.id));
            return { jobId, rows: [...prev, ...rows.filter((r) => !seen.has(r.id))].sort((a, b) => a.id - b.id) };
          });
        }
        setEvError(undefined);
      } catch (e) {
        if (!signal.aborted) setEvError(toApiError(e));
      }
      return j;
    },
    jobActive,
    [jobId, nonce],
  );
  return { job, events: eventState.jobId === jobId ? eventState.rows : [], evError };
}
