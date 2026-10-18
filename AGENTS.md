# AGENTS.md — MediaPack

Read `PLAN.md` first; it is the spec. `apps/web` is the dashboard; `apps/web/components/console/CONTRACT.md` is the component contract.

## Stack
- `apps/web`: Next.js App Router (TypeScript, Tailwind), Node runtime. Dashboard + REST + MPP endpoint.
- `apps/mcp`: mcp-use server, thin proxy over REST, deployed to Manufact.
- `worker/`: Python 3.14 (`python3.14 -m venv .venv`), ffmpeg, faster-whisper, imagehash. Runs in Blaxel.
- Supabase: Postgres + Storage + Realtime. Provisioned via Stripe Projects.
- Payments: Stripe test mode, MPP + Link. Agent messaging: Primitive.

## Rules
- UI renders only from persisted `events` rows. Simulated replay lives only in `apps/web/lib/demo/`.
- Every API error: `{error, hint, next_action}`.
- Purchase is idempotent on `quote_id`. Allowance is enforced in SQL (`consume_allowance`).
- Never claim root cause from video. Always label test mode.
- Verify an integration's real API before writing against it; log findings below.

## Integration findings (fill in during hour 0)
- Stripe MPP:
- Link CLI:
- Primitive: Native browser CLI login verified in the existing account (CLI 1.65.0). Authenticated account/domains/endpoints/signing-secret/send-permissions reads succeeded. One managed domain is verified/active, no endpoints existed at discovery. CLI OAuth access expires in one hour; use a persistent server API key for deployment rather than copying the CLI session. Webhook signing is account-scoped; retrieve the existing secret and do not rotate it during setup. Current API permissions report managed-zone sends without the old opt-in gate; verify actual permissions, not older notes.
- Blaxel: Next.js and worker images built remotely in workspace mediapack. Applications feature unavailable; sandbox preview hosting verified. Web host allows standby and has one-hour idle deletion. Existing sandbox-openai gateway is deployed (gpt-4o-mini); empty POST validation supports Responses/chat but rejects audio transcriptions (403). A custom sandbox does not receive OPENAI_API_KEY automatically; its identity file did not authenticate to the gateway. Hosted gateway/worker-launch authentication still needs a supported runtime credential. Never set a positive execution timeout on the long-running web process; current sandbox-api kills it when elapsed even without keepAlive.
- mcp-use / Manufact:
- Stripe Projects: Installed CLI 1.54.0 / plugin 0.50.0; live catalog verified Free ($0), Pro ($25/month), and the project deployable. User chose Free; upload contract and setup bucket now use 50 MiB (52,428,800 bytes). Native CLI login succeeded, but only a sandbox context is authorized. Projects returns `PROJECTS_CONTEXT_MISMATCH` requiring live infrastructure credentials; switching that account to live was rejected for lack of access. Parent-business CLI authorization is pending; no Supabase resource exists yet. Do not repeat login/init for this mismatch or change app payments out of test mode. `init --mode manual --skip-skills` preserves the app/instructions. `env --pull` only writes locally; runtime credentials still need Blaxel restart. Exclude `.projects` from build archives.
