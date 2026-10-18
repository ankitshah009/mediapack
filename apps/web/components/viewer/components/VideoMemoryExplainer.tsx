export function VideoMemoryExplainer() {
  return (
    <section aria-labelledby="video-memory-title" className="rounded-2xl border border-line bg-card p-5">
      <p className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted">Reusable video memory</p>
      <h2 id="video-memory-title" className="mt-1 font-display text-lg font-semibold tracking-tight">
        Index once. Ask more. Retrieve less.
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Keep a timestamped memory of what a video shows and says. Agents search that timeline across questions,
        then retrieve only the cited frames or seconds they need.
      </p>

      <details className="mt-4 border-t border-line pt-2">
        <summary className="cursor-pointer rounded py-2 text-sm font-medium">
          How it works and one measured example
        </summary>
        <div className="mt-2 space-y-4 text-sm">
          <p className="text-muted">
            Supabase stores the visual observations, speech and timestamps. Primitive coordinates requests and
            results across disposable Blaxel workers. Follow-up questions reuse the stored index instead of
            processing the whole video again.
          </p>
          <div className="rounded-xl border border-line bg-paper p-4">
            <p className="font-mono text-[11px] text-muted">One measured example · October 18, 2026</p>
            <p className="mt-2 text-sm">A 45.9-second video, indexed from 23 frames:</p>
            <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted">Initial visual indexing</dt>
                <dd className="mt-0.5 font-mono text-base font-semibold">
                  326,710 <span className="text-xs font-normal text-muted">input tokens</span>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted">One follow-up search</dt>
                <dd className="mt-0.5 font-mono text-base font-semibold">
                  2,507 <span className="text-xs font-normal text-muted">input tokens</span>
                </dd>
              </div>
            </dl>
            <p className="mt-3 font-medium">
              99.2% less input for that search than repeating the same full visual indexing pass.
            </p>
            <p className="mt-2 text-xs leading-relaxed text-muted">
              The first indexing cost is still required. This is one video and one question, not guaranteed
              savings or a benchmark against another engine.
            </p>
          </div>
        </div>
      </details>
    </section>
  );
}
