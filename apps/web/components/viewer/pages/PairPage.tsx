"use client";

import { useState } from "react";
import { Api } from "../api/client";
import { toApiError } from "../api/hooks";
import { ErrorPanel, Shell } from "../components/Shell";
import { Button, Card, Mono } from "../components/ui";
import { useNavigate } from "../lib/router";

export function PairPage() {
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ReturnType<typeof toApiError>>();
  return (
    <Shell crumb={<span>Pair</span>}>
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight">Pair this browser with your agent</h1>
        <p className="mt-1 text-sm text-muted">
          Your agent owns its uploads. To watch them here, ask it (or run the CLI yourself) for a one-time code, then enter it below.
          The code expires in five minutes and works once.
        </p>
      </div>
      <Card>
        <p className="text-sm">In the terminal where your agent is set up:</p>
        <p className="mt-2 rounded-lg bg-code px-3 py-2 text-rail-text">
          <Mono>node scripts/mediapack.mjs pair</Mono>
        </p>
        <form
          className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setErr(undefined);
            try {
              await Api.pair(code.trim());
              navigate("/");
            } catch (x) {
              setErr(toApiError(x));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="flex-1">
            <label htmlFor="pair-code" className="text-sm font-medium">
              Pairing code
            </label>
            <input
              id="pair-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code"
              autoCapitalize="characters"
              spellCheck={false}
              required
              minLength={8}
              className="mt-1 block min-h-11 w-full rounded-xl border border-line bg-paper px-3 font-mono text-base tracking-wider"
            />
          </div>
          <Button type="submit" variant="primary" busy={busy} disabled={code.trim().length < 8}>
            Pair browser
          </Button>
        </form>
        {err && <div className="mt-4"><ErrorPanel error={err} /></div>}
      </Card>
      <p className="text-xs text-muted">
        No agent? Go back to Videos and start a new session instead; you will own only what you upload here.
      </p>
    </Shell>
  );
}
