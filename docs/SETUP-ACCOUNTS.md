# Operator setup (things only you can do)

Put server values in `apps/web/.env.local` (gitignored). The Next.js dashboard and API run on Blaxel; the MCP proxy runs separately on Manufact. Never paste secrets into chat. Sources: `docs/integrations/*.md`.

## 1. Stripe (merchant, sandbox) — unblocks payments
1. Dashboard → Settings → Team and security → **MCP and CLI access** → enable.
2. Sandbox → create/claim a **Stripe profile** → copy `profile_test_…` → `STRIPE_PROFILE_ID`.
3. `brew install stripe/stripe-cli/stripe` then `stripe login`.
4. Sandbox secret key → `STRIPE_SECRET_KEY=sk_test_…`.
5. Local webhooks: `stripe listen --forward-to localhost:3000/webhooks/stripe` → `STRIPE_WEBHOOK_SECRET=whsec_…`
   (deployed endpoint gets its own secret later; subscribe it to `payment_intent.succeeded`).

## 2. Stripe Projects — provisions Supabase

Stripe CLI 1.54.0 and Projects plugin 0.50.0 are installed. A live catalog read lists `supabase/free` ($0), `supabase/pro` ($25/month), and the `supabase/project` deployable. The user selected **Free**; no paid plan is authorized. Native CLI sign-in succeeded, but its only authorized account context is a sandbox. Projects initialization returns `PROJECTS_CONTEXT_MISMATCH` because it requires live-mode infrastructure credentials; the suggested `stripe switch context <account_id> --live --format json` was rejected because that account has no authorized live access. No Supabase project has been created.

Authorize the parent business account through Stripe's native CLI reauthorization flow, then select its live context. If the authorization link opens the sandbox, use the Dashboard account selector to leave the sandbox and select its parent business before opening [Projects setup](https://dashboard.stripe.com/projects/new). Do not repeatedly re-run login or init for the same context mismatch. Complete the native reauthorization step returned by the CLI once parent-account access has been granted, then inspect the authorized contexts. Infrastructure authorization does not change MediaPack's `PAYMENTS_MODE=test`.

Browser sessions need the database and a stable `CAPABILITY_PEPPER`; uploads also need Storage. Stripe merchant payment credentials are separate and are not required for these two steps.

```sh
stripe projects catalog supabase --json --interactive=false
stripe projects init mediapack --mode manual --skip-skills --preflight --json --yes --interactive=false
# After browser authentication and a passing preflight:
stripe projects init mediapack --mode manual --skip-skills --json --yes --interactive=false
```

The manual mode preserves the existing Next.js app. `--skip-skills` preserves the repository's agent instructions. Use Stripe's native browser login when requested; do not paste keys into chat. Inspect existing resources before provisioning to avoid duplicates. Provision the selected Free plan before its project, using the actual installed `add --help`:

```sh
stripe projects add supabase/free --json --yes --accept-tos --interactive=false
stripe projects add supabase/project --name mediapack-db --config '{"name":"mediapack","region":"americas"}' --json --yes --accept-tos --interactive=false
stripe projects env --pull --json --interactive=false
```

**Free-plan upload policy:** Supabase documents a 50 MB global file limit on Free. MediaPack now enforces 50 MiB (52,428,800 bytes) in browser preflight, REST, MCP, CLI, worker validation and bucket setup. The bucket cannot override the project-wide limit, so verify the actual global setting after provisioning. Keep Free selected; Pro starts at $25/month and is not authorized. Sources: [Supabase limits](https://supabase.com/docs/guides/storage/uploads/file-limits), [pricing](https://supabase.com/pricing).

Read the actual generated environment variable names without printing their values. Transfer the pooled `DATABASE_URL`, `SUPABASE_URL`, and server-only `SUPABASE_SERVICE_ROLE_KEY` into private `apps/web/.env.blaxel`, preserving the existing independent internal secrets. Projects' `env --pull` writes locally; it does not configure the Blaxel process. Keep `.projects` vault/cache and `.env*` out of builds and source control.

Initialize the provisioned schema and private `mediapack-private` bucket with the setup helper:

```sh
node scripts/setup-supabase.mjs --plan
node scripts/setup-supabase.mjs --apply
```

The helper tracks migration checksums and applies each new migration atomically. It refuses an untracked pre-existing app schema rather than rerunning the non-idempotent SQL. It requires an exact private 50 MiB bucket and refuses a smaller readback. Verify the project global limit separately. Restart the current Blaxel web host using the exact command in the README, then prove `/health` database connectivity, `/viewer/bootstrap`, the browser cookie, authenticated video listing and a real signed upload. Do not treat configured environment names as runtime verification.

Blaxel already has a credited workspace; reuse it without provisioning another plan. `stripe projects share` can produce the submission stack link after a service exists.

## 3. Buyer (agent side of MPP)
**Default — no extra account:** the `mppx` CLI pays our 402 in sandbox using a Stripe test key + test card
(`MPPX_STRIPE_SECRET_KEY=sk_test_…`, `-M paymentMethod=pm_card_visa`). `scripts` CLI: `buy <job> --via mppx`.
**Optional — real agent wallet:** Link CLI (needs a US/Canada Link account + Link mobile app approval per spend):
```
npm i -g @stripe/link-cli
link-cli auth login
```
then `buy <job> --via link`. Server path is identical for both.

## 4. Primitive — unblocks the work transport
The user's existing account is now connected through native CLI browser login. Its managed domain was verified active; the existing signing secret and control/worker service addresses were saved privately, and one disabled org-wide HTTP webhook was created for the current Blaxel origin. A signed empty payload returned 200 from the deployed receiver; a tampered signature returned 401. No email was sent and real work delivery remains unverified.

1. In [Primitive API keys](https://www.primitive.dev/app/settings/api-keys), create a persistent server key and save `PRIMITIVE_API_KEY` in `apps/web/.env.blaxel`. Do not substitute the CLI OAuth access token; it expires in one hour. A dedicated `PRIMITIVE_WORKER_API_KEY` is optional; setup preserves one if present, otherwise reuses the provided server key for replies.
2. Run `node scripts/setup-primitive.mjs --plan`, then `node scripts/setup-primitive.mjs --apply`. Setup reuses the existing signing secret, derives valid service addresses and prepares only the app-owned disabled endpoint; it never rotates the org secret or changes unrelated routing. It also handles a changed preview URL using the saved endpoint ownership record.
3. Restart with `scripts/host-blaxel.mjs ... --restart` to apply the private settings. The deployed receiver's signature checks are verified, but Supabase remains unconfigured.
4. Once Supabase is configured and deployed health reports database OK, verify signed event persistence before enabling the owned endpoint. Then prove a real Primitive work request and worker reply. Current `/send-permissions` reports managed-zone recipients allowed; the older managed-send opt-in note is superseded by the actual account permissions.

## 5. Blaxel — unblocks the worker
`brew install blaxel-ai/blaxel/blaxel` → `bl login` → `BL_WORKSPACE`, `BL_API_KEY`. Image deploy steps: `worker/README.md`.

## 6. OpenAI — unblocks indexing/search
The current worker directly uses `OPENAI_API_KEY`, the configured vision/search model (default `gpt-5.4-mini`), and `whisper-1`. The user's Blaxel workspace already provides a deployed `sandbox-openai` gateway configured with `gpt-4o-mini`. Empty request validation verified Responses/chat routes, while transcription is rejected with 403. Gateway vision/search adaptation and supported hosted authentication are still needed; raw OpenAI credentials are not automatically injected into custom sandboxes. Audio requires a permitted provider endpoint or local transcription. See [verified gateway findings](integrations/primitive-blaxel.md).

## 7. Hosting
Reuse the user's existing Blaxel credits and workspace for the Next.js application and media worker. The root `blaxel.toml` and `Dockerfile` package the standalone Next.js application; `worker/blaxel.toml` and `worker/Dockerfile` package the worker. Do not provision another paid plan.

The current workspace lacks Applications private-preview access, so the web host uses a **sandbox public preview**. Build the root image with `bl push --type sandbox --name mediapack-web --workspace mediapack --yes --timeout 20m`, then run `node scripts/host-blaxel.mjs --image sandbox/mediapack-web:<built-immutable-tag> --env-file apps/web/.env.blaxel`. The script assigns the preview origin automatically and reports missing provider configuration. Per the user's cost requirement, it disables process keep-alive to allow automatic standby and enforces deletion after one hour idle (`ttl-idle`). Blaxel counts resume/suspend events for that timer; a continuously active session can also expire after one hour. After deletion, rerun the script and update callback/Manufact origins if changed. Standby stops active compute billing, but snapshot/image storage can still be billed. Add `--restart` to apply updated server environment values.

Deploy the independent `apps/mcp` service on Manufact following `apps/mcp/README.md`. Give it only `MEDIAPACK_API_URL` pointing to the Blaxel Next.js HTTPS origin. Set the Next.js `PUBLIC_BASE_URL` to that same origin and optional `MCP_PUBLIC_URL` to the Manufact MCP endpoint.
