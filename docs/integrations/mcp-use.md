# mcp-use (Manufact) integration notes

> Dated framework research. The deployed-service design is the independent [Manufact MCP proxy](../../apps/mcp/README.md) forwarding to Next.js on Blaxel; earlier combined-server examples are reference material. See [build decisions](../../DECISIONS.md) and [verification](../verification.md) before treating a local probe as a provider deployment.

Researched 2026-10-17 against **mcp-use@2.10.1** and **create-mcp-use-app@2.0.10**. I scaffolded a throwaway probe app, read the installed `node_modules/mcp-use` type definitions and bundle, and ran HTTP requests against both `mcp-use dev` and `mcp-use build && mcp-use start`.

Labels:
- **VERIFIED (probe)**: I ran it locally and saw the result.
- **VERIFIED (source)**: read in installed package code or types.
- **VERIFIED (docs)**: read on docs.mcp-use.com.
- **UNVERIFIED**: inferred, not confirmed.

> Heads-up: v2 changed the vocabulary. Widgets are now **Views** in `views/<name>/view.tsx` (not `resources/`). There is **no `useWidget`** in 2.10.1. The hooks are `useToolContext`, `useCallTool`, etc. VERIFIED (source: `dist/react/index.d.ts` has 0 matches for `useWidget`.)

---

## 1. Scaffold

The non-interactive command. VERIFIED (probe; flags from `create-mcp-use-app --help`):

```bash
npx -y create-mcp-use-app@2.0.10 mediapack-mcp \
  --template mcp-apps --npm --install --no-skills --sdk-version 2.10.1
```

Available templates are `blank`, `mcp-apps` (React views) and `mcp-server` (tools only). VERIFIED (probe: `--list-templates`.)

Generated layout. VERIFIED (probe):

```
index.ts            # server entry: new MCPServer(...), server.tool(...), export default server
mcp-env.d.ts        # generated; registers `typeof import("./index.js")` so views get typed tool names
views/my-view/view.tsx (+ view.css, components)
public/             # icon.svg etc.; served under /mcp/_mcp-use/public/
package.json        # scripts: dev=mcp-use dev, build=mcp-use build, start=mcp-use start, deploy=mcp-use deploy, typecheck
tsconfig.json
```

- Dependencies are `mcp-use 2.10.1`, `react ^19.2`, `zod ^4.4`, and `typescript ^7`.
- `engines.node` is `>=22.22.2`. Local node is v26, which works.
- The mcp-use package depends on `hono ^4.13.7`, `@modelcontextprotocol/server 2.3.1`, `@modelcontextprotocol/ext-apps 2.0.3`, `@mcp-use/cli 4.4.1` and `@mcp-use/inspector`. VERIFIED (source: `node_modules/mcp-use/package.json`.)

## 2. Tools and custom HTTP routes

### Tools (zod)

VERIFIED (source: generated `index.ts`, README):

```ts
import { MCPServer } from "mcp-use";
import { z } from "zod";

const server = new MCPServer({ name: "mediapack", version: "1.0.0", /* basePath: "/mcp" default */ });

export const searchVideo = server.tool(
  {
    name: "search_video",
    description: "Search an indexed video",
    inputSchema: z.object({ jobId: z.string().describe("Job id"), query: z.string() }),
    outputSchema: z.object({ hits: z.array(z.object({ t: z.number(), text: z.string() })) }),
    // view: { name: "player" },   // optional: binds views/player/view.tsx (outputSchema then required)
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ jobId, query }, ctx) => ({
    content: [{ type: "text", text: "..." }],
    structuredContent: { hits: [] },
  }),
);
export default server;
```

Export each tool constant (`export const x = server.tool(...)`). Views get their tool types from those exports. VERIFIED (source: `server.d.ts` JSDoc.)

The server is **stateless per request**: "a fresh SDK `McpServer` is built from it for every HTTP request … put pools and caches at module scope". VERIFIED (source: `server.d.ts`.)

### Custom HTTP routes: Hono

`MCPServer` exposes a Hono app. VERIFIED (source: `dist/server.d.ts`):

```ts
readonly app: Hono<TEnv>;
readonly get / post / put / patch / delete / all: Hono<TEnv>["get"] ...
readonly fetch: (...args) => Promise<Response>;   // Web-standard handler
use(path: `/${string}` | "*", ...handlers: MiddlewareHandler<TEnv>[]): this;   // Hono middleware
use("mcp:tools/call", ...)                         // typed MCP-operation middleware
on("mcp:tools/call", ...)                          // read-only observer (metrics/activity feed)
```

The docs example is `server.get("/health", (c) => c.json({ ok: true }))`. VERIFIED (docs: https://docs.mcp-use.com/typescript/api-reference/server/middleware.md.)

**The raw body works.** `await c.req.text()` or `c.req.arrayBuffer()` inside `server.post(...)` returns the exact bytes. VERIFIED (probe):
- I sent a JSON body with irregular whitespace and HMAC-SHA256-signed it client-side.
- The route recomputed the HMAC over `c.req.text()` and matched (`{"ok":true,"len":68}`) in both dev and production start.
- The framework's JSON-parse middleware does not consume the body for custom routes.

```ts
server.post("/api/webhooks/stripe", async (c) => {
  const raw = await c.req.text();
  const event = stripe.webhooks.constructEvent(raw, c.req.header("stripe-signature")!, process.env.STRIPE_WEBHOOK_SECRET!);
  // ...
  return c.json({ received: true });
});
```

(Stripe's `constructEvent` accepts a string payload. That is standard Stripe Node SDK behaviour; I did not run it in this probe.)

**HTTP 402 works.** I returned `c.json({...}, 402, { "WWW-Authenticate": 'Payment ...' })` and got status 402 with the header intact. VERIFIED (probe.)

**Body size limits:**
- **MCP endpoint (`/mcp`): 4 MiB.** The SDK has `DEFAULT_MAX_REQUEST_BODY_SIZE=4*1024*1024` and returns "Payload Too Large: Request body must not exceed N bytes". VERIFIED (source: `dist/index-node.js`.)
- **Custom Hono routes: no framework limit.** A 20 MB and a 200 MB `POST` to a custom route both succeeded locally (`{"bytes":200000000}`). VERIFIED (probe.)
- You can add `hono/body-limit` yourself.
- The Manufact edge/proxy limit is UNVERIFIED (not documented).

Long requests: a 3 s handler is fine locally. VERIFIED (probe.) Manufact's request timeout is UNVERIFIED.

## 3. Views (MCP-app widgets) and a standalone SPA

**Views:**
- Each view lives in `views/<name>/view.tsx` with a default-exported React component.
- A tool binds it with `view: { name: "<name>", csp: {...}, prefersBorder }`.
- The view reads data with `useToolContext<"tool-name">()` (status, toolInput, toolOutput) and calls tools with `useCallTool("tool")`.
- Other hooks: `useHostContext`, `useDisplayMode` (inline/pip/fullscreen), `useOpenExternal`, `useSendFollowUp`, `useViewState`, `useViewTool` (host-callable tools defined in the view), `useModelContext`, `useFiles`, `useDeepLink`, `useViewTheme`, and the `Image` component.

VERIFIED (source: `dist/react/index.d.ts` and generated view.tsx; docs: https://docs.mcp-use.com/v2/typescript/mcp-apps/quickstart.md.)

**Production assets.** The build writes views to `.mcp-use/build/views/<name>/assets/*.js|css` and serves them under `/mcp/_mcp-use/views/...`. `public/` is served under `/mcp/_mcp-use/public/`. VERIFIED (probe build output; source `views/routes.d.ts`.)

**Tailwind v4 is built in for views.** The CLI injects `virtual:mcp-use/tailwind.css` unless `tailwind: false`. The built view CSS contains Tailwind's `@layer properties` output. VERIFIED (source: `@mcp-use/cli/dist/chunk-M4QQDJBS.js`; probe build CSS.)

**CSP:**
- Configure per view with `csp: { connectDomains, resourceDomains, frameDomains, baseUriDomains }`.
- Or set it globally with the `CSP_URLS` env var, or per category (e.g. `CSP_CONNECT_DOMAINS`).
- The server's own `MCP_URL` origin is auto-appended to `connectDomains`.
- A `<video>` player loading Supabase Storage URLs needs the storage host allowed. How hosts map `resourceDomains` to `media-src` is UNVERIFIED; test in Inspector "Widget-Declared" mode.

VERIFIED (docs: https://docs.mcp-use.com/v2/typescript/mcp-apps/content-security-policy.md.)

**Views are not a website.** They render inside host iframes (ChatGPT, Claude, Inspector). I found no supported "open this view at `/` in a browser" mode. VERIFIED absence (docs quickstart doesn't cover it; no such route in `views/routes.d.ts`.)

**A full SPA at `/` from the same server works.** I registered `server.get("*", ...)` after the API routes. It serves `web-dist/index.html` plus `/assets/*`, with fallback to index.html for deep links, and passes `/mcp*` and `/api*` through with `next()`. In both dev and production start:
- `/` returned the SPA.
- `/jobs/abc` returned the SPA (client routing works).
- `/assets/app.js` returned JS.
- `/mcp` (HTML Accept) still returned the mcp-use landing page.
- `POST /mcp` initialize and tools/list still worked.

VERIFIED (probe.) The handler:

```ts
const WEB_ROOT = join(process.cwd(), "web-dist");   // cwd = project root under `mcp-use start` (VERIFIED probe)
server.get("*", async (c, next) => {
  const p = new URL(c.req.url).pathname;
  if (p.startsWith("/mcp") || p.startsWith("/api")) return next();
  const rel = normalize(p).replace(/^\/+/, "");
  for (const f of [rel, "index.html"]) {
    try { return c.body(await readFile(join(WEB_ROOT, f || "index.html")), 200, { "content-type": TYPES[extname(f || "index.html")] ?? "application/octet-stream" }); } catch {}
  }
  return next();
});
```

- The SPA must be built separately (e.g. `vite build --outDir web-dist`) and chained into the build command: `"build": "vite build && mcp-use build"`.
- `mcp-use build` does not build a root SPA. VERIFIED (it only builds `index.ts` + views.)
- Add path-traversal hardening and cache headers in production. The probe used `normalize`, which is minimal.

**Other official integration: embed in Next.js.** `mcp-use/next` exports `withMcpUse(nextConfig, { entry, basePath: "/api/mcp" })` and `createNextHandler(server)`. You mount these at `app/api/mcp/[[...path]]/route.ts` and use plain `next dev/build/start`. VERIFIED (source: `dist/next/*.d.ts`; docs: https://docs.mcp-use.com/v2/typescript/server/nextjs-drop-in.md.) There are also `mcp-use/vite` (`mcpUse()` plugin) and `mcp-use/tanstack-start` adapters. VERIFIED (source.)

## 4. Deploy to Manufact

VERIFIED (CLI `mcp-use deploy --help`; docs: https://docs.mcp-use.com/v2/typescript/server/deployment/mcp-use.md):

```bash
npx mcp-use login                     # or: --api-key "$MCP_USE_API_KEY" --org ORG
npx mcp-use deploy --name mediapack --env-file .env.production    # GitHub-backed (needs Manufact GitHub App + pushed origin)
npx mcp-use deploy --name mediapack --no-github --env-file .env.production --yes --json   # managed upload, headless
npx mcp-use deployments logs <DEPLOYMENT_ID> --build --follow
npx mcp-use servers env set <server> STRIPE_WEBHOOK_SECRET=whsec_...   # change env without redeploy
```

- **Flags:**
  - `--build-command` and `--start-command` override auto-detection.
  - `--dockerfile <path>` gives a custom image.
  - `--root-dir` sets the monorepo subdir.
  - `--region` selects a region.
  - `--branch` deploys to a preview env.
- **Env and secrets:**
  - `--env KEY=VALUE` (repeatable) or `--env-file`. The CLI does not echo values.
  - `--no-github` uploads exclude `.env*`, so secrets must go through `--env` or `servers env set`.
  - No separate "secrets" store is documented.
- **Upload cap:** 80 MB compressed archive (no-GitHub mode).
- **URL shape:** the docs say to copy the generated URL from the dashboard and not infer it. The public examples look like `https://<adjective-noun-xxxxx>.run.mcp-use.com/mcp`. VERIFIED (README examples, e.g. `https://yellow-shadow-21833.run.mcp-use.com/mcp`.) Custom domains are mentioned. UNVERIFIED how to set them.
- **Not documented anywhere I could find:** request timeout, edge body limit, memory, long-running requests, background work, websocket/SSE duration. All UNVERIFIED.
- **Runtime model.** Deploys run `build` and then `start` as a Node process, and Dockerfiles are accepted. That suggests a long-lived container where in-process background work (setTimeout, polling loops) survives between requests. **UNVERIFIED.** Instance count, scale-to-zero and restarts are unknown, so do not rely on in-memory state. Keep durable state in Supabase.
- `listen()` binds `127.0.0.1` by default. Use `HOST=0.0.0.0` when self-hosting. VERIFIED (source: `config.d.ts`.)

## 5. Local testing

- **Dev server:** `npm run dev` (`mcp-use dev`) serves `http://localhost:3000/mcp`. The Inspector is at `http://localhost:3000/mcp/inspector`. It hot-reloads. Use `--port`, `--no-open` and `--no-inspector`. VERIFIED (probe: "dev server ready … MCP endpoint … Inspector".)
- **Public tunnel:** `mcp-use dev --tunnel` gives a public URL for testing in ChatGPT and Claude. VERIFIED (CLI help.)
- **Headless client and screenshots.** VERIFIED (README):
  ```bash
  npm i -D @mcp-use/client
  npx mcp-use client connect local http://localhost:3000/mcp
  npx mcp-use client local tools list
  npx mcp-use client local tools call search_video jobId=j1 query="error dialog"
  npx mcp-use screenshot --server local --tool search_video jobId=j1 --output view.png
  ```
- **Claude Code.** VERIFIED (`claude mcp add --help` in the installed CLI):
  ```bash
  claude mcp add --transport http mediapack http://localhost:3000/mcp
  # deployed: claude mcp add --transport http mediapack https://<generated>.run.mcp-use.com/mcp [-H "Authorization: Bearer ..."]
  ```
- **Production parity:** `mcp-use build && mcp-use start` (add `--with-inspector` to mount the Inspector in production). VERIFIED (probe + CLI help.)

## 6. Monetization and payments

- **No payment, x402 or MPP helpers in mcp-use 2.10.1.** grep for `x402|payment|stripe|mpp` across `mcp-use/dist` and `@mcp-use/cli/dist` found nothing relevant. The docs index (llms.txt) has no payments or monetization pages. VERIFIED (source + docs index.)
- **Build it yourself:**
  - The HTTP 402 MPP route as a plain `server.post` route, verified working (§2).
  - Or gate tools with `server.use("mcp:tools/call", async (ctx, next) => { /* check allowance */ return next(); })`. VERIFIED that the API exists (source `server.d.ts`). Allowance logic is ours.
- **Third-party x402-for-MCP options** (not mcp-use): `@civic/x402-mcp`, and Coinbase's `@x402/mcp` pattern, which carries the payment in `_meta["x402/payment"]`. These are crypto/USDC, not Stripe MPP, so they don't fit our Stripe track. UNVERIFIED in depth.
  - https://docs.cdp.coinbase.com/x402/seller/mcp-payments.md
  - https://lobehub.com/mcp/civic-x402-mcp
- **OAuth adapters** exist (`mcp-use/oauth/{clerk,auth0,workos,supabase,keycloak,better-auth,scalekit,convex}`) and `mixedAuth` serves signed-in and signed-out tools from one endpoint. Supabase is useful for us. VERIFIED (source: `package.json` exports, `config.d.ts`.)

---

## Recommendation

**Yes. One mcp-use app can host all three.** I proved each piece locally in dev and production start on 2.10.1:

1. MCP tools at `/mcp`, plus views for ChatGPT and Claude.
2. A REST API through `server.get/post` (Hono), including a raw-body HMAC webhook and a 402 route.
3. A full React SPA at `/` with deep-link fallback, served by a catch-all `server.get("*")` from a separately Vite-built `web-dist/`.

Build it as:

```
"build": "vite build --config web/vite.config.ts && mcp-use build",
"start": "mcp-use start"
```

Then `npx mcp-use deploy --env-file .env.production`.

**What I could not verify:** Manufact's request timeout, edge body limit, scaling and background-work semantics. Mitigations:
- Keep `/api/webhooks/*` fast: verify, insert into Supabase, return 200.
- Never upload video bytes through the app. Use signed Supabase Storage upload URLs.
- Run heavy work in the Blaxel worker, not in the request.
- On the first deploy, run a quick limits probe (`/api/slow?s=30,90,300`, 10/50 MB POST) against the live URL.

**Smallest fallback if Manufact's edge proves hostile** (raw body altered, short timeouts, or a catch-all `/` not routed): keep the existing **Next.js app** (`apps/web`) as the one deployable.
- Embed the same `MCPServer` with the official `mcp-use/next` adapter (`withMcpUse` + `createNextHandler` at `app/api/mcp/[[...path]]/route.ts`).
- Next route handlers give the raw body via `await req.text()`.
- Deploy to Vercel, or to Manufact with `--build-command "next build" --start-command "next start"`. Manufact running a Next app is UNVERIFIED; `--dockerfile` is the escape hatch.
- Tradeoff: the dashboard is already Next + Tailwind, so this avoids rewriting it as a Vite SPA. But the Manufact track may want the server deployed on Manufact itself, which favours the standalone mcp-use app.

Probe project (throwaway): `/private/tmp/claude-501/-Users-ankitparagshah-GitHub-mediapack/295817e4-3932-4048-92b8-32a73f9e913b/scratchpad/mcpuse-probe/probe-app` (`index.ts` bottom = probe routes; `../../probe.mjs` = HTTP test script).
