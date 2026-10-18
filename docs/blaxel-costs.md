# Blaxel costs and expiration

Rates rechecked against official public documentation on October 18, 2026 at
11:33 UTC. These are estimates, not the workspace's billing balance or a spending
guarantee.

**$500 should comfortably cover development and a modest demo workload.** It does
not establish a permanent hosting budget without knowing traffic, worker duration,
concurrency, or the credits' expiry date. The 4 GB worker upgrade fits this demo
budget without assuming additional paid model APIs or credit purchases.

## Timestamped actual usage

A read-only Billing Explorer API request filtered to workspace `mediapack`
returned **$0.06580812391032317** in aggregate USD usage for **October 18, 2026,
midnight through 4:34:03 AM Pacific** (`2026-10-18T07:00:00Z` through
`2026-10-18T11:34:03.371Z`). That is approximately **6.58 cents**. The prior
October 17 check was $0.01231111686005005 through 4:51 PM Pacific; it is historical,
not today's result. Metering can lag recent builds and runtime activity, so this
is a timestamped usage report rather than a final invoice.
[Billing Explorer](https://docs.blaxel.ai/Security/Billing-Explorer-API).

The metrics endpoint did not expose the current available credit balance or
credit expiry. Do not subtract this usage from $500 and present the result as a
verified balance; the $500 scenarios below assume the stated budget is available.

## Rates and estimates

[Blaxel's pricing table](https://blaxel.ai/pricing) lists sandbox compute at
$0.0000115 per allocated GB-second, snapshot storage at $0.20/GB-month, and image
storage at $0.045/GB-month. Compute is charged while active; standby retains
billable snapshots.

For planning, model the 2048 MB web sandbox as 2 billable GB and each upgraded
4096 MB worker as 4 billable GB. Confirm invoice memory units before treating
these numbers as exact:

```text
active compute = allocated GB × active seconds × $0.0000115
one 2 GB web-hour = $0.0828
one 4 GB worker-hour = $0.1656
```

| Scenario | Estimated compute |
|---|---:|
| Web host active continuously for 30 days | $59.62 |
| One 4 GB worker active for 5 minutes | $0.0138 |
| One 4 GB worker active for 10 minutes | $0.0276 |
| 1,000 4 GB workers, each active for 10 minutes | $27.60 |
| Web active 2 hours/day for 30 days + 100 ten-minute 4 GB workers | $7.73 |
| Always-active web for 30 days + 1,000 ten-minute 4 GB workers | $87.22 |
| One 4 GB worker active for its entire 30-minute lifetime | $0.0828 |

The table uses hypothetical durations, not measured average job cost. Actual
4 GB cloud worker samples include:

| Observed sample | Execution time | Compute for that execution interval only |
|---|---:|---:|
| Talk video indexing | 15.208 seconds | $0.000700 (0.070 cents) |
| Settings video indexing | 21.932 seconds | $0.001009 (0.101 cents) |

The talk sample's approximately 44.9 seconds of audio took about 8.6 seconds to
transcribe locally. An earlier isolated ASR smoke took 7.618 seconds for 44.864
seconds of audio; neither is a general latency promise. The indexing calculations
are `4 × execution seconds × $0.0000115`, not complete billed job totals. They
exclude VM startup, time outside the measured execution interval, separate
upload/probe/search/evidence operations, retries, storage and model usage. Some
transfer work may occur inside the measured interval; use provider metering for
total active sandbox time instead of adding or subtracting guessed overhead.

If spent entirely on worker compute, $500 buys approximately **3,019 aggregate
4 GB active hours**, or **18,115 ten-minute runs**, before web hosting, storage,
and other costs. Concurrent workers consume this budget together. Doubling worker
memory doubles the active-second rate; any time saving must be measured.

## Idle behavior and deletion

[Automatic standby](https://docs.blaxel.ai/Get-started) normally follows about five
seconds of inactivity. A sleeping sandbox can resume on traffic without a new
deployment. Connections and process `keepAlive` can prevent standby; avoid
always-on health polling and close unused preview tabs.
[Standby control](https://docs.blaxel.ai/Sandboxes/Standby-control) describes the
connection behavior.

The hosting script defaults to `ttl-idle: 1h` with action `delete` and accepts
`--idle-ttl` in whole hours from `1h` through `24h`. **The current r7 judging host
uses `--idle-ttl 24h`**, verified by provider readback, while retaining
`keepAlive=false` so automatic standby can stop compute billing when idle.
Workers keep their 30-minute maximum lifetime and bounded operation deadlines.
Check the helper's reported policies when reusing a sandbox. On r7, a fresh
70.493-second observation covered two successful recovery cron runs with zero
idle HTTP; all 12 recovery checks passed. This verifies the scheduler does not
wake an empty workload, not that retained storage or all account usage is free.

Before new launches, the bounded cleanup path can reclaim matching MediaPack
workers only after verifying successful completed processes, ownership, image and
no in-flight work; standby alone does not prove completion. A real service-account
smoke deleted four eligible workers while preserving the web host. Private proof:
`.blaxel/worker-reaper-proof.json`. This reduces retained worker storage and quota
use; the 30-minute lifetime remains the fallback when no later launch runs cleanup.
The final paid settings flow also exercised cleanup during ordinary deployed
frame retrieval, reclaiming a completed current-image search worker. Both source
flows passed; this runtime proof does not replace the timestamped billing total
or establish the account's available credit balance.

**Blaxel's idle TTL tracks resume and suspend events, not each request.** A
continuously active sandbox can therefore expire after its configured interval
even while being used. The 24h judging override avoids the 1h policy interrupting
an active demo; it does not promise perpetual availability or 24h of free active
compute. This is not a traditional “time since the last HTTP request” policy.
Multiple expiry rules delete on the first matching condition.
[Expiration policies](https://docs.blaxel.ai/Sandboxes/Expiration).

Expiration deletes the sandbox and its preview. Rerun the documented hosting
command to recreate it; verify its public URL and update API/webhook configuration
if that URL changes. Persist important data in the configured external database
and storage, rather than the sandbox filesystem.

## Remaining costs and limits

- Deletion is not a hard dollar cap. Public traffic, concurrent workers, retries,
  and build/deployment activity still require monitoring.
- Retained images remain separately billable after sandbox deletion; retained
  volumes or separate snapshots also need their own cleanup.
- Estimates exclude OpenAI/model usage, Supabase, Primitive, Stripe, and Manufact.
  Blaxel credits should not be assumed to pay those providers.
- This review did not inspect the actual balance, automatic top-ups, credit
  expiration, or any account-specific commercial terms. Check those in the Blaxel
  billing console before leaving the demo unattended.
