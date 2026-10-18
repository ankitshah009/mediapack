# Stripe integration research: MPP, Link CLI, Checkout, Projects

> Dated research, including examples from earlier designs. Use [account setup](../SETUP-ACCOUNTS.md) for current operator commands, [build decisions](../../DECISIONS.md) for the implemented topology, and [verification](../verification.md) for executed account/runtime checks. A source-verified API example is not evidence of a successful payment or provisioned account.

Researched 2026-10-17. Sources are primary: docs.stripe.com, the published npm tarballs (`mppx@0.13.5`, `@stripe/link-cli@0.28.0`, both downloaded with `npm pack` into a scratch directory and read, not installed), and the Stripe GitHub repos (`stripe-samples/machine-payments`, `stripe/stripe-node`, `stripe/stripe-cli`).

Legend: **VERIFIED** (source) means I read it in a primary source. **UNVERIFIED** means it is inferred or not confirmed, and it says what would confirm it.

At the initial research snapshot, neither `stripe` nor `link-cli` was installed; `brew info stripe` resolved to `stripe-cli` 1.53.1 and npm listed `@stripe/cli` 1.54.0. Later CLI installation and Projects findings are recorded in the account setup and verification documents linked above.

---

## TL;DR (decisions)

1. **MPP server = `mppx` (wevm) + `stripe` Node SDK.** This is the package Stripe's own docs use. `npm view mppx` reports latest = **0.13.5** (repo `github.com/wevm/mppx`). VERIFIED: https://docs.stripe.com/payments/machine/mpp and the npm registry.
2. **Breaking gotcha: in mppx 0.13.5, `stripe.create()` throws unless you pass a shared atomic `store`.** Stripe's docs snippet and the official sample (pinned to `mppx ^0.9.2`) omit it. Pass `store: Store.memory()` for SPT-only, or a Supabase-backed atomic store if we enable Tempo on multi-instance Vercel. VERIFIED: `dist/stripe/server/Methods.js` in mppx 0.13.5: `if (typeof store?.update !== 'function') throw new Error('stripe.create() requires a shared atomic \`store\` for replay protection.')`.
3. **Card via SPT has a $0.50 USD minimum.** The $0.50 pack is exactly at the floor. Stablecoin (Tempo USDC.e) has a 0.01 minimum. VERIFIED: docs.stripe.com/payments/machine/mpp, and mppx `minimumChargeAmountByCurrency.usd = 50n`.
4. **Binding a payment to our quote:** use `externalId: quote_id`, which is HMAC-bound in the challenge and echoed by the client. Add `paymentIntentOptions.metadata` (`{quote_id, job_id, pack_id}`), which lands on the Stripe PaymentIntent. VERIFIED from mppx source.
5. **Link CLI is npm, not brew:** `npm i -g @stripe/link-cli` (bin `link-cli`) or `npx @stripe/link-cli`. To pay, run `link-cli mpp pay <url> ...`. **Every spend needs human approval in the Link app.** Approval policies (autonomous spend under $X) exist only as a beta "delegated approval" flow "available only to select OAuth clients". The CLI can only *retrieve* a policy, not create one. VERIFIED from the link-cli 0.28.0 bundle and README.
6. **Unify both paths on the PaymentIntent.** Checkout (`payment_intent_data.metadata`) and MPP (`paymentIntentOptions.metadata`) both produce a Stripe PaymentIntent that carries our `quote_id`. One idempotent `grant_pack(quote_id, payment_intent_id, source)` function feeds `packs`, called from the MPP handler (synchronously) and from the webhook (`checkout.session.completed` and `payment_intent.succeeded`).

---

## 1. MPP server side

### 1.1 Package and install
- `npm install mppx stripe`. VERIFIED: https://docs.stripe.com/payments/machine/mpp ("Install dependencies").
- npm `mppx` latest = `0.13.5`, repository `git+https://github.com/wevm/mppx.git`. VERIFIED (`npm view mppx`).
- Export subpaths in 0.13.5 include `mppx/server`, `mppx/client`, `mppx/hono`, `mppx/nextjs`, `mppx/express`, `mppx/stripe/server/spt`, `mppx/mcp-sdk/server`, `mppx/proxy`. `hono` is an optional peer `>=4.12.25`, and `next` is an optional peer `>=16.2.6`. Our `apps/web` uses `next 16.4.2`, which satisfies that. VERIFIED (`package.json` exports/peerDependencies in the tarball).

### 1.2 Prerequisite: Stripe profile, used as `networkId`
> "Create a Stripe profile in the Stripe Dashboard. Store your profile's `profile_` ID. You use this value as the `networkId`"
```bash
curl https://api.stripe.com/v2/network/business_profiles/me \
  -u sk_test_...: \
  -H "Stripe-Version: 2026-07-29.preview"
```
In a sandbox, use the `profile_test_` ID. VERIFIED: https://docs.stripe.com/payments/machine/mpp ("Before you begin" and "Test with a Stripe sandbox").

### 1.3 Official endpoint code (copied from Stripe docs)
```typescript
import crypto from 'crypto';
import StripeClient from 'stripe';
import { Mppx, stripe } from 'mppx/server';

// Secret used to secure payment challenges
// https://mpp.dev/protocol/challenges#challenge-binding
const mppSecretKey = crypto.createHmac("sha256", process.env.STRIPE_SECRET_KEY!).update("mpp-challenge-signing").digest("base64");

const stripeClient = new StripeClient(process.env.STRIPE_SECRET_KEY!);

const stripeMachinePayments = stripe.create({
  client: stripeClient,
  networkId: process.env.STRIPE_PROFILE_ID!,
  livemode: !process.env.STRIPE_SECRET_KEY!.includes('_test_')
});

const mppx = Mppx.create({
  methods: stripeMachinePayments.defaultMethods(),
  secretKey: mppSecretKey,
});

export async function handler(request: Request) {
  const response = await mppx.charge({ amount: '0.50' })(request);
  if (response.status === 402) return response.challenge;
  return response.withReceipt(Response.json({ data: '...' }));
}
```
VERIFIED: https://docs.stripe.com/payments/machine/mpp ("Create your endpoint").
**Caveat (VERIFIED from mppx 0.13.5 source):** as written, this throws at `stripe.create()` on 0.13.5 because `store` is missing. Add `store: Store.memory()`, imported via `import { Mppx, Store, stripe } from 'mppx/server'`. Changelog: "Required shared replay storage for Stripe Tempo payment methods."

### 1.4 How verification works (VERIFIED: mppx 0.13.5 `dist/stripe/server/Charge.js`)
1. The first request has no credential, so it gets a `402` with `WWW-Authenticate: Payment id=..., realm=..., method="stripe", intent="charge", request="<b64>"`. The challenge is HMAC-bound with `secretKey`, so a client can't tamper with the amount, networkId, or externalId. Default expiry is 5 minutes (CHANGELOG: "Server handlers default to `Expires.minutes(5)`").
2. The client retries with a credential `{ spt, externalId? }`. The server:
   - asserts the challenge hasn't expired;
   - rejects the call if `credential.externalId !== request.externalId`, with reason "credential externalId does not match this route request";
   - calls `client.paymentIntents.create({ amount, currency, confirm: true, automatic_payment_methods: {enabled: true, allow_redirects: 'never'}, shared_payment_granted_token: spt, metadata }, { apiVersion: <preview>, idempotencyKey: \`mpp_${challenge.id}_${spt}\` })`;
   - if Stripe replies `idempotent-replayed: true`, throws "Payment has already been processed." (replay protection);
   - throws if PI status is `requires_action` or isn't `succeeded`;
   - returns the receipt `{ method: 'stripe', status: 'success', reference: pi.id, externalId? }` in the `Payment-Receipt` header via `withReceipt`.
3. PaymentIntent metadata always includes `machine_payment: 'true'`, `mpp_sdk`, `mpp_intent`, and `mpp_challenge_id`, merged with our metadata.

### 1.5 Attaching our quote_id/job_id (VERIFIED from mppx source)
The charge request schema (`dist/stripe/Methods.js`) accepts `description`, `externalId`, `metadata` (record<string,string>), and `paymentIntentOptions` (`{customer?, hooks?, metadata?, receipt_email?}` or a request-scoped resolver function).
- `externalId`: put in the challenge and bound by HMAC. The mppx client copies it into the credential automatically (`dist/stripe/client/Charge.js`: `payloadExternalId = requestExternalId ?? externalId`). **Use `externalId = quote_id`.**
- `metadata`: goes to `methodDetails.metadata`, which is **visible in the challenge** and merged into PI metadata. The key `externalId` is reserved.
- `paymentIntentOptions.metadata`: **not serialized into the challenge** (`void paymentIntentOptions`), but merged into PI metadata. Use this for server-only fields.
- Per-call options also include `meta` (server correlation data serialized as challenge `opaque`, which clients must echo) and `scope` (route/resource binding). VERIFIED: `dist/server/Mppx.d.ts` `MethodFn.Options`.
- Getting the receipt server-side: `Receipt.fromResponse(response)` (from `mppx`), or subscribe with `mppx.onPaymentSuccess(handler)`. The handler context includes `receipt`, `request`, and `challenge`. VERIFIED: `dist/Receipt.d.ts` and `dist/server/Mppx.d.ts`.

### 1.6 Payment methods
- **Card/Link via SPT:** this is the default. `spt.charge()` uses `paymentMethodTypes: ['card', 'link']`, `currency: 'usd'`, `decimals: 2`. VERIFIED: mppx `dist/stripe/server/Methods.js`.
- **Stablecoin (Tempo USDC.e, Solana USDC; x402 Base USDC):** needs a crypto deposit address (`POST /v1/crypto/deposit_addresses -d network=tempo`, `Stripe-Version: 2026-07-29.preview`) passed as `depositAddresses: { tempo }`. You also enable **Stablecoins and Crypto** in Dashboard payment methods, which goes through Stripe review. US businesses qualify except New York. VERIFIED: https://docs.stripe.com/payments/machine and /payments/machine/mpp.
- In 0.13.5, `defaultMethods()` with no `depositAddresses` returns SPT only. VERIFIED: CHANGELOG `bc3c626`.
- SPTs are available to US businesses in all states. VERIFIED: https://docs.stripe.com/payments/machine ("Availability").
- **Minimums:** SPT card is 0.50 USD. Stablecoin is 0.01 USDC. mppx won't offer the SPT method below the currency minimum (`canOffer`). VERIFIED (docs + source).
- **Recommendation:** SPT-only for the hackathon. Tempo adds a Dashboard approval and replay-store complexity, and Link CLI pays with SPT anyway.

### 1.7 Test mode
- Use an `sk_test_...` key, and `livemode` is detected from it. Use a `profile_test_...` networkId. VERIFIED: docs ("Test with a Stripe sandbox").
- Validator: `npx mppx@latest validate http://localhost:4242`. Docs say: "In a sandbox, the CLI automatically completes roundtrip test transactions against your server." VERIFIED: https://docs.stripe.com/payments/machine/mpp.
- Headless test buyer, with no Link approval: `export MPPX_STRIPE_SECRET_KEY=sk_test_... && npx mppx <url>` (mppx CLI Stripe support). VERIFIED: mppx CHANGELOG `6e2be11`. **UNVERIFIED** whether this still works unchanged in 0.13.5; run `npx mppx --help` to confirm.

### 1.8 Minimal Hono example for MediaPack
This combines Stripe's sample `stripe-samples/machine-payments/mpp/server/node-typescript/main.ts` (Hono, `c.req.raw`) and the monetized-MCP sample (`mppx.compose([...])` with a per-request amount/description) with the 0.13.5 `store` fix. The API shapes are VERIFIED from source. The composition is mine and has not been run (**UNVERIFIED at runtime**).
```typescript
import crypto from "node:crypto";
import { Hono } from "hono";
import { Mppx, Store, stripe } from "mppx/server";
import { Receipt } from "mppx";
import StripeClient from "stripe";

const stripeClient = new StripeClient(process.env.STRIPE_SECRET_KEY!);
const mppSecretKey = crypto.createHmac("sha256", process.env.STRIPE_SECRET_KEY!)
  .update("mpp-challenge-signing").digest("base64");

const smp = stripe.create({
  client: stripeClient,
  networkId: process.env.STRIPE_PROFILE_ID!,           // profile_test_... in sandbox
  livemode: !process.env.STRIPE_SECRET_KEY!.includes("_test_"),
  store: Store.memory(),                                 // REQUIRED in mppx 0.13.x
});
const mppx = Mppx.create({ methods: [smp.spt.charge()], secretKey: mppSecretKey });

const app = new Hono();
app.post("/api/v1/jobs/:id/purchase", async (c) => {
  const quote = await loadOpenQuote(c.req.param("id"));  // 404/409 if missing/expired/already paid
  const result = await mppx.charge({
    amount: (quote.amount_cents / 100).toFixed(2),       // "0.50" (>= SPT minimum)
    description: `MediaPack video pack ${quote.id}`,
    externalId: quote.id,                                 // HMAC-bound, echoed by client
    paymentIntentOptions: { metadata: { quote_id: quote.id, job_id: quote.job_id, source: "mpp" } },
  })(c.req.raw);
  if (result.status === 402) return result.challenge;

  const res = result.withReceipt(Response.json({ ok: true })) as Response;
  const receipt = Receipt.fromResponse(res);              // receipt.reference = pi_...
  const pack = await grantPack({ quoteId: quote.id, paymentIntentId: receipt.reference, source: "mpp" });
  return result.withReceipt(Response.json({ pack_id: pack.id, job_id: quote.job_id, receipt })) as Response;
});
```
In Next.js App Router, the same core works in `app/api/v1/jobs/[id]/purchase/route.ts`: `export async function POST(req: Request) { ... mppx.charge({...})(req) ... }`. `mppx/nextjs` also exists (`payment(mppx.charge, opts, handler)`), but it takes static options, so for per-quote amounts use the core form above. VERIFIED (types).

---

## 2. Buyer side: Link CLI (`@stripe/link-cli`)

All items are VERIFIED from the npm README and `dist/cli.js` of `@stripe/link-cli@0.28.0` (repo `github.com/stripe/link-cli`), unless marked otherwise.

- **Install:** `npm i -g @stripe/link-cli`, or `npx @stripe/link-cli`. The bin is `link-cli`. There is **no Homebrew formula** documented. Agents can add skills with `npx skills add stripe/link-cli`, or use MCP: `{"command":"npx","args":["@stripe/link-cli","--mcp"]}`. `link-cli serve` binds 127.0.0.1:54321.
- **Region:** "For now, this is only available to US and Canadian Link accounts." The user needs a Link account (app.link.com) with a saved card, plus the Link mobile app to approve.
- **Auth (interactive, user must do it):** `link-cli auth login --client-name "MediaPack demo"`. It prints a URL and a short phrase. You approve in Link. Then `link-cli auth status`. Agents can use `--interval 5 --timeout 300`.
- **Guided onboarding:** `link-cli onboard`. Test-only demo: `link-cli demo --only-spt` ("always uses test mode — no real charges").
- **Pay an MPP 402 endpoint (full flow):**
  ```bash
  link-cli mpp pay https://<host>/api/v1/jobs/MP-1042/purchase \
    -X POST -d '{}' \
    --context "Buying one MediaPack video pack (quote q_123) so the agent can search and retrieve evidence from the indexed video. User asked for this." \
    --test
  ```
  `mpp pay` "Handles the full 402 flow: probes the URL, parses the challenge, creates a spend request, gets approval, and pays with the SPT. Pass --spend-request-id to skip creation and use a pre-approved spend request." Flags: `--spend-request-id`, `--method/-X`, `--data/-d`, `--header/-H` (repeatable), `--context` (min 100 chars, required without `--spend-request-id`), `--amount` (cents, else taken from the challenge), `--payment-method-id`, `--test`, `--approved-challenge`.
  Stripe's docs use `npx @stripe/link-cli mpp pay http://localhost:4242/paid -X POST -d '{}' --context "..."` with no `--test`. VERIFIED: docs.stripe.com/payments/machine/mpp. **UNVERIFIED** whether `--test` is required against a sandbox server. Try it with `--test` first: test mode returns test credentials and "will not charge the underlying payment method".
- **Two-step flow (pre-approve, then pay):**
  ```bash
  link-cli mpp decode --challenge '<raw WWW-Authenticate value>'      # extracts network_id
  link-cli spend-request create --credential-type shared_payment_token --network-id profile_test_... \
    --amount 50 --currency usd --context "<>=100 chars>" --test --request-approval \
    --metadata "quote_id:q_123"
  link-cli spend-request retrieve lsrq_... --interval 2 --max-attempts 300
  link-cli mpp pay <url> --spend-request-id lsrq_... -X POST -d '{}'
  ```
  The SPT is one-time-use: "if payment fails, create a new spend request". Approval window is 30 minutes, and credentials are valid for 12 hours.
- **Approval policies / autonomous spend under $X:** `link-cli approval-policy retrieve --format json` returns "the rules that grant the current app authority to create spend requests without manual approval". Each rule has an action, a per-purchase limit, and optionally allowed payment methods. The only flag that uses it is `--use-approval-policy`: "Use approval policy through the delegated approval flow (beta, available only to select OAuth clients)". **No CLI command creates a policy.** Conclusion: plan for **per-spend approval in the Link app** as the baseline. Autonomous spend is not available to us. **UNVERIFIED** whether a policy can be configured in the Link app UI for a plain CLI session. Run `link-cli approval-policy retrieve` after login to check.
- **Limits:** max $500 per request, $500 daily, $20,000 per 30 days, 50 creations per hour, 10 concurrent approved requests. Account spend limits show via `link-cli user-info retrieve --format json` (`agent_wallet_spend_limits`).
- **Programmatic clients:**
  - `mppx/client`: `Mppx.create({ methods: [...] })` "polyfills `globalThis.fetch`" so 402s are handled automatically. Use `polyfill: false` to opt out. The Stripe client method needs a `createToken` callback, which mints the SPT and needs a secret key server-side. That makes it a merchant/test tool, not a consumer wallet. VERIFIED: `dist/client/Mppx.d.ts` and `dist/stripe/client/Methods.d.ts`.
  - `@stripe/link-sdk` (TypeScript), plus Go and Python (`stripe-link-sdk`): "credential-only Link client... Authentication flows and credential persistence remain the embedding application's responsibility". It also exports reusable agent tools. VERIFIED (link-cli README "SDKs").
  - Agent shell-out: in `--format json` mode, `mpp pay` returns `_next.pay_argv` / `_next.poll_argv` for `execFile` without a shell. VERIFIED (README).

---

## 3. Stripe Checkout (human path)

### 3.1 Create a session with metadata
These parameters are VERIFIED: https://docs.stripe.com/api/checkout/sessions/create.
- `mode` (`payment`), `line_items` (price or `price_data`), `success_url` (supports `{CHECKOUT_SESSION_ID}`), `cancel_url`, `client_reference_id` (max 200), `metadata`, `payment_intent_data` (subset passed to the PaymentIntent), `ui_mode` (default `hosted_page`, also `embedded_page`, `elements`, `form`), `expires_at` (30 minutes to 24 hours).

```typescript
const session = await stripe.checkout.sessions.create({
  mode: "payment",
  line_items: [{ quantity: 1, price_data: {
    currency: "usd", unit_amount: quote.amount_cents,
    product_data: { name: `MediaPack video pack (${quote.job_id})` } } }],
  client_reference_id: quote.id,
  metadata: { quote_id: quote.id, job_id: quote.job_id, source: "checkout" },
  payment_intent_data: { metadata: { quote_id: quote.id, job_id: quote.job_id, source: "checkout" } },
  success_url: `${BASE_URL}/jobs/${quote.job_id}?session_id={CHECKOUT_SESSION_ID}`,
  cancel_url: `${BASE_URL}/jobs/${quote.job_id}`,
}, { idempotencyKey: `checkout_${quote.id}` });
// redirect to session.url
```
The parameter names are VERIFIED, and `price_data`/`product_data` is standard Checkout usage, but this exact object was not executed (**UNVERIFIED at runtime**). The idempotency option comes from stripe-node and the idempotency docs: "provide an additional `IdempotencyKey` element to the request options"; keys up to 255 chars, prunable after 24 hours, and a parameter mismatch errors. VERIFIED: https://docs.stripe.com/api/idempotent_requests.

### 3.2 Webhook verification (raw body)
- "Stripe requires the raw body of the request to perform signature verification... Any manipulation to the raw body of the request causes the verification to fail." VERIFIED: https://docs.stripe.com/webhooks.
- Next.js App Router, Stripe's official example (copied, trimmed):
  ```typescript
  event = stripe.webhooks.constructEvent(
    await req.text(),
    stripeSignature as string,
    webhookSecret
  );
  ```
  VERIFIED: https://github.com/stripe/stripe-node/blob/master/examples/webhook-signing/nextjs/app/api/webhooks/route.ts
- Web-standard runtimes (Deno/edge/Hono on Workers) use `await stripe.webhooks.constructEventAsync(body, signature, webhookSecret, undefined)` with `body = await request.text()`. VERIFIED: stripe-node `examples/webhook-signing/deno/main.ts`.
- Events: handle `checkout.session.completed` and `checkout.session.async_payment_succeeded`. Fulfill only if `payment_status != 'unpaid'`. "your `fulfill_checkout` function might be called multiple times, possibly concurrently, for the same Checkout Session." VERIFIED: https://docs.stripe.com/checkout/fulfillment?payment-ui=stripe-hosted.
- Duplicates: "guard against duplicated event receipts by logging the event IDs you've processed". Ordering isn't guaranteed. Return 2xx quickly. Sandbox retries "three times over the course of a few hours", while live mode retries up to 3 days. Default signature tolerance is 5 minutes. VERIFIED: https://docs.stripe.com/webhooks.
- Checkout waits up to 10 seconds for your `checkout.session.completed` webhook response before redirecting to `success_url`. With the Stripe CLI it redirects immediately. Also fulfill on the landing page for low latency. VERIFIED: fulfillment doc.
- Local: `stripe listen --forward-to localhost:3000/api/stripe/webhook`. It prints `whsec_...`. `stripe trigger checkout.session.completed`. VERIFIED (webhooks doc; the `trigger` syntax is shown for `payment_intent.succeeded`. **UNVERIFIED** that the `checkout.session.completed` fixture name exists; run `stripe trigger --help`).

---

## 4. Stripe Projects

VERIFIED: https://docs.stripe.com/projects, unless marked otherwise.
- **It's a Stripe CLI plugin:** `stripe plugin install projects`. The bootstrap guide says Stripe CLI must be >= 1.40.0 (`brew install stripe/stripe-cli/stripe` or `brew upgrade stripe/stripe-cli/stripe`). Agent skill: `npx skills add https://docs.stripe.com --skill stripe-projects -g -y`.
- **Status:** the Stripe page says "Stripe Projects CLI". Supabase's page says "Stripe Projects is currently a developer preview" and "behavior may change". VERIFIED: https://supabase.com/docs/guides/integrations/stripe-projects.
- **Commands:**
  ```bash
  stripe projects init [name]              # writes .projects/, adds .env + vault to .gitignore, writes agent skills to .skills/
  stripe projects catalog | catalog <provider> | catalog <category>
  stripe projects search <keyword> --json
  stripe projects add <provider>/<service>
  stripe projects link <provider>          # associate/create provider account without provisioning
  stripe projects status [--json]
  stripe projects env                      # list names (values hidden)
  stripe projects env --pull               # write active env file (.env) + refresh vault
  stripe projects billing add | show | update --limit <amount> [--provider <p>]
  stripe projects upgrade <provider>|<provider>/<service>|<resource>
  stripe projects rotate | remove | open <provider> | spend | llm-context
  stripe projects share                    # URL encoding the service stack (no creds), never expires
  stripe projects init --from <URL>        # recreate stack from a share URL
  ```
  Global flags: `--json --no-interactive --auto-confirm --quiet --accept-tos --debug`.
- **Supabase:** `stripe projects add supabase/project`. VERIFIED (Stripe quickstart and Supabase docs). It bundles Postgres, Auth, Storage, Edge Functions, and Realtime. Supabase's doc uses `stripe projects env --sync`, but Stripe's uses `env --pull`. **UNVERIFIED which flag the installed plugin accepts**; run `stripe projects env --help`. **UNVERIFIED env var names** written for Supabase; read them with `stripe projects env` after provisioning.
- **Blaxel:** in the Stripe provider table as "Hosting, sandbox, AI". VERIFIED (docs.stripe.com/projects). From Blaxel's blog (https://blaxel.ai/blog/stripe-projects-blaxel-integration), VERIFIED as the provider's own source:
  ```bash
  stripe projects catalog blaxel
  stripe projects add blaxel/tier-1      # plan; "You must activate a top-up plan before provisioning a sandbox or drive"
  stripe projects add blaxel/sandbox
  stripe projects add blaxel/drive       # optional (Agent Drive)
  stripe projects env --pull
  ```
  Env vars written: `BLAXEL_PLAN_API_KEY` and `BLAXEL_PLAN_WORKSPACE`. Then `brew install blaxel; export BL_API_KEY=$BLAXEL_PLAN_API_KEY; bl login $BLAXEL_PLAN_WORKSPACE`. No Blaxel account is needed ("Stripe Projects will create one automatically"). It's "fully usage-based via credits". **Prerequisite: a saved payment method** (`stripe projects billing add`). Paid tiers are charged through a Shared Payment Token. **This is real spend, not test mode.** Set `stripe projects billing update --limit <amount> --provider blaxel` first. **UNVERIFIED:** the tier-1 top-up price, and whether a hackathon credit applies. Run `stripe projects catalog blaxel` to see it.
- **Credentials:** encrypted in `.projects/vault/vault.json` and the Stripe Secret Store. Plaintext goes to `.env` (or `.env.<env>`) with mode 600. `.projects/state.json` and `state.local.json` are committed, while vault, cache, and `.env*` are gitignored. Production hosts (Vercel) are **not** synced automatically: "Stripe Projects doesn't automate this step."
- **Agent mode:** to avoid browser pop-ups, first sign in, `stripe projects link <provider>`, and `stripe projects billing add`.

---

## 5. Stripe CLI on macOS

- Homebrew: `brew install stripe`. VERIFIED: https://github.com/stripe/stripe-cli README. Locally, `brew info stripe` resolves to formula `stripe-cli` 1.53.1. The legacy tap form `brew install stripe/stripe-cli/stripe` is what docs.stripe.com/projects uses. Either is fine. Prefer `brew install stripe`, since homebrew-core has it.
- npm alternative: `npm install -g @stripe/cli` (Node >= 18; npm latest 1.54.0). VERIFIED (README, npm).
- `stripe login`: a browser pairing code that you confirm in the Dashboard. "For Stripe CLI versions newer than v1.50.0, an Administrator or IAM Admin must enable CLI access before you can authenticate", under Settings → Team and security → MCP and CLI access. Credentials are stored in the OS secure credential store and refreshed automatically. Flags: `--interactive` (paste API key), `--non-interactive` (prints JSON with `browser_url`, `verification_code`, `next_step`), `--complete=<poll-url>`, `--new-session`. Also `stripe login list` and `stripe switch` (sandbox selection). VERIFIED: https://docs.stripe.com/cli/login.
- **Note:** `stripe login --non-interactive` lets an agent start login, but **the user still has to approve in the browser**.

---

## 6. Recommended implementation: two paths, one `packs` entitlement

### Data model (add to `supabase/migrations`)
```sql
create table packs (
  id text primary key default 'pk_' || replace(gen_random_uuid()::text,'-',''),
  quote_id text not null unique references quotes,      -- one pack per quote: the idempotency key
  job_id text not null references jobs,
  source text not null check (source in ('mpp','checkout')),
  stripe_payment_intent_id text not null unique,         -- second guard: one PI -> one pack
  stripe_checkout_session_id text unique,
  amount_cents int not null, currency text not null default 'usd',
  allow_text_tokens int, allow_frames int, allow_clip_ms int,  -- copied from quote at grant time
  livemode boolean not null default false,
  created_at timestamptz default now()
);
create table stripe_events (id text primary key, type text, received_at timestamptz default now()); -- webhook dedup

create or replace function grant_pack(p_quote_id text, p_pi text, p_source text, p_cs text default null)
returns packs language plpgsql as $$
declare q quotes; r packs;
begin
  select * into q from quotes where id = p_quote_id for update;
  if not found then raise exception 'QUOTE_NOT_FOUND'; end if;
  insert into packs(quote_id, job_id, source, stripe_payment_intent_id, stripe_checkout_session_id,
                    amount_cents, currency, allow_text_tokens, allow_frames, allow_clip_ms)
  values (q.id, q.job_id, p_source, p_pi, p_cs, q.amount_cents, q.currency,
          q.allow_text_tokens, q.allow_frames, q.allow_clip_ms)
  on conflict (quote_id) do nothing;
  select * into r from packs where quote_id = p_quote_id;
  update jobs set status = 'paid' where id = q.job_id and status = 'quoted';
  insert into events(job_id, type, source, data)
    values (q.job_id, 'payment.verified', 'stripe', jsonb_build_object('payment_id', p_pi, 'amount_cents', q.amount_cents, 'via', p_source));
  return r;
end $$;
```
`consume_allowance` then reads limits from `packs` instead of `quotes`. Replace the PLAN's `payments.quote_id unique` with `packs.quote_id unique`, or keep `payments` as a raw ledger. One caveat: the `events` insert runs even on a duplicate grant. Guard it with `if r.created_at > now() - interval '1 second'`, or emit only when the insert inserted a row (`GET DIAGNOSTICS`).

### Path B: agent (MPP), synchronous
1. `create_job` returns `purchase_url = /api/v1/jobs/:id/purchase`. The response includes the `link-cli mpp pay` command line in `next_action`.
2. On `POST /purchase`, load the open quote. If a pack already exists for it, return `200 {pack}` without charging, so retries don't double-charge. Expired quote → `409 QUOTE_EXPIRED` with a re-quote hint.
3. `mppx.charge({ amount, externalId: quote.id, description, paymentIntentOptions: { metadata: {quote_id, job_id, source:'mpp'} } })`. A 402 returns the challenge (log `payment.challenge`). A 200 calls `grant_pack(quote.id, receipt.reference, 'mpp')` and returns `{pack_id, receipt}`.
4. If `grant_pack` fails after the PI succeeded, the webhook below heals it, because the PI metadata carries `quote_id`.

### Path A: human (Checkout), async
1. The dashboard "Buy pack" button calls `POST /api/v1/jobs/:id/checkout`, which creates a Checkout Session (metadata on both the session and `payment_intent_data`, `idempotencyKey: checkout_${quote.id}`) and redirects.
2. On `success_url` (`?session_id=`), retrieve the session. If `payment_status === 'paid'`, call `grant_pack(metadata.quote_id, session.payment_intent, 'checkout', session.id)`. This is the fast path.
3. In the webhook `POST /api/stripe/webhook`: `constructEvent(await req.text(), sig, whsec)`, then insert `event.id` into `stripe_events` (on conflict, return 200). Then:
   - `checkout.session.completed` / `checkout.session.async_payment_succeeded` with `payment_status != 'unpaid'` → `grant_pack(..., 'checkout', session.id)`;
   - `payment_intent.succeeded` with `metadata.quote_id` and `metadata.machine_payment === 'true'` → `grant_pack(..., 'mpp')` (MPP backstop).
   Return 2xx fast.

### Same-URL content negotiation (optional, from Stripe's MCP sample)
The Stripe MCP sample redirects browsers (`Accept: text/html`) to checkout and gives agents the 402 on the same `purchase_url`. VERIFIED: `stripe-samples/machine-payments/mcp/server/node-typescript/server.ts`. We can do the same: `GET purchase_url` from a browser → redirect to the Checkout Session, and `POST` from an agent → MPP 402. Then MCP's `create_job` returns a single `purchase_url` that works for both.

### Failure UX
- 402 body/headers come from mppx. Our wrapper errors stay `{error, hint, next_action}`.
- `VerificationFailedError` (SPT declined or reused) → tell the agent "SPT is one-time-use; create a new spend request".
- Link approval timeout (30 minutes) → `POLLING_TIMEOUT` from link-cli. Re-run `mpp pay`.

---

## 7. Commands the USER must run interactively

These need a browser, phone approval, or real money, so an agent can't finish them alone.
```bash
# 0. (Dashboard, once) Enable CLI access: Settings → Team and security → MCP and CLI access (needed for CLI > v1.50.0)
# 0b. (Dashboard, once) Create/claim a Stripe profile in the sandbox → note profile_test_... (= STRIPE_PROFILE_ID)

# 1. Stripe CLI
brew install stripe                      # or: npm install -g @stripe/cli
stripe login                             # browser pairing-code approval; pick the sandbox
stripe login list                        # confirm sandbox account

# 2. Stripe Projects (provisions real third-party accounts; Blaxel tier costs real money)
stripe plugin install projects
cd /Users/ankitparagshah/GitHub/mediapack
stripe projects init mediapack           # may open browser for auth
stripe projects billing add              # saved payment method (needed for paid tiers / Blaxel)
stripe projects billing update --limit <amount> --provider blaxel   # cap spend first
stripe projects catalog blaxel           # read the tier-1 price before adding
stripe projects add supabase/project     # may prompt provider ToS / browser
stripe projects add blaxel/tier-1        # paid top-up plan (charged via SPT)
stripe projects add blaxel/sandbox
stripe projects env --pull               # (if rejected, try: stripe projects env --sync)
stripe projects share                    # URL for the submission

# 3. Link CLI (US/CA Link account with a card + Link mobile app)
npm i -g @stripe/link-cli                # or prefix every command with: npx @stripe/link-cli
link-cli auth login --client-name "MediaPack demo"   # visit URL, enter phrase in Link
link-cli approval-policy retrieve --format json      # expect "no policy" → per-spend approval
link-cli mpp pay https://<host>/api/v1/jobs/<id>/purchase -X POST -d '{}' --test \
  --context "Buying one MediaPack video pack for job <id> so the agent can search the indexed video; requested by the user."
# → approve the push in the Link app

# 4. Local webhooks (keep running during dev)
stripe listen --forward-to localhost:3000/api/stripe/webhook   # copy whsec_... into STRIPE_WEBHOOK_SECRET
```
Agent-runnable (no human): `npx mppx@latest validate http://localhost:3000/api/v1/jobs/<id>/purchase` (sandbox roundtrip), and the curl calls to `/v2/network/business_profiles/me` once `STRIPE_SECRET_KEY` is in `.env`.

## 8. Open items to confirm on first run
- [ ] `stripe.create({... store: Store.memory()})` boots without error on mppx 0.13.5, and `npx mppx validate` passes.
- [ ] `link-cli mpp pay ... --test` against an `sk_test_` server results in a test PI in the Dashboard with `metadata.quote_id`.
- [ ] Which `env` flag the Projects plugin accepts (`--pull` vs `--sync`), and which Supabase env var names it writes.
- [ ] Blaxel tier-1 price and hackathon credit.
- [ ] `stripe trigger checkout.session.completed` fixture exists.
