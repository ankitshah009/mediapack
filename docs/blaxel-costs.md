# Blaxel costs and expiration

Rechecked against public documentation on 2026-10-17 at 23:49 UTC. These are estimates, not the
workspace's billing balance or a spending guarantee.

**$500 should comfortably cover development and a modest demo workload.** It does
not establish a permanent hosting budget without knowing traffic, worker duration,
concurrency, or the credits' expiry date. The 4 GB worker upgrade fits this demo
budget without assuming additional paid model APIs or credit purchases.

## Actual usage today

A read-only Billing Explorer API request filtered to workspace `mediapack`
returned **$0.01231111686005005** in aggregate USD usage for October 17, 2026,
midnight through 4:51:12 PM Pacific (`2026-10-17T07:00:00Z` through
`2026-10-17T23:51:12.063Z`). That is approximately **1.23 cents**. Metering can lag
recent builds and runtime activity, so this is a timestamped usage report rather
than a final invoice. [Billing Explorer](https://docs.blaxel.ai/Security/Billing-Explorer-API).

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

These are calculations from the listed compute rate, not measured MediaPack
performance. The local ASR runtime and model are not yet installed or benchmarked;
these example durations do not predict transcription speed. Startup, cleanup,
retries, overlapping workers, and retained storage add usage.

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

The web hosting script applies `ttl-idle: 1h` with action `delete`. Workers have a
30-minute maximum lifetime; the launcher also bounds individual operations. Check
the hosting script's reported expiration policies when reusing an existing
sandbox.

**Blaxel's idle TTL tracks resume and suspend events, not each request.** A
continuously active sandbox can therefore expire one hour after waking even while
being used. This is an intentional cost/availability tradeoff for the demo, not a
traditional “one hour since the last HTTP request” policy. Multiple expiry rules
delete on the first matching condition.
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
