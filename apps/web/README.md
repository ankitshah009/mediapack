# MediaPack Next.js application

This is the dashboard and HTTP API. Next.js App Router serves the viewer at `/app` and mounts the shared backend from [`../mediapack/src`](../mediapack/src) in the Node runtime. Keep the complete MediaPack checkout: this directory cannot build independently of that backend source.

The dashboard displays persisted video, job, allowance and event state. The separate [MCP service](../mcp/README.md) runs on Manufact and forwards requests to this app on Blaxel.

## Run locally

Use Node 22.22.2 or newer and the package's pinned pnpm version. From the repository root:

```sh
cd apps/mediapack
npm ci
cd ../web
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm dev
```

Open `http://localhost:3000/app`. Put private server values in `.env.local`; never prefix provider credentials with `NEXT_PUBLIC_` or commit the environment file.

Creating a browser session requires `DATABASE_URL`, applied database migrations and a stable `CAPABILITY_PEPPER`. Uploads additionally require `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and the private Storage bucket. Check `/health` for `database: "ok"`, then exercise session creation and upload. A rendered page or 200 health response alone does not prove those integrations work.

See [account setup](../../docs/SETUP-ACCOUNTS.md) and [release checks](../../docs/RELEASE-CHECKLIST.md).

## HTTP routes

| Route | Purpose |
| --- | --- |
| `/app`, `/app/pair`, `/app/v/:videoId`, `/app/jobs/:jobId` | Dashboard, pairing, video and job views |
| `/v1/*` | Client, video, purchase, search and evidence operations |
| `/viewer/*` | Browser session creation, pairing, status and logout |
| `/health` | Integration configuration and database connectivity |
| `/webhooks/stripe`, `/webhooks/primitive` | Verified provider callbacks |
| `/internal/*` | Recovery tick and scoped worker artifact access |
| `/llms.txt` | Agent-facing service instructions |

Browser sessions use an HttpOnly cookie. Agent clients use their own capability. Provider secrets stay on the server; workers receive scoped artifact access rather than database credentials.

## Verify and build

From this directory:

```sh
pnpm test
pnpm lint
pnpm exec tsc --noEmit
pnpm build
pnpm start
```

`pnpm start` requires a completed build. The root Dockerfile builds standalone Next.js output with the shared backend dependencies. Run Docker builds from the repository root.

## Blaxel hosting

Use the [root deployment instructions](../../README.md#worker-image-and-recovery). The web host requests 2048 MiB; separate media workers request 4096 MiB. Hosting currently uses a public sandbox preview because Application Runtime is unavailable in the configured workspace.

The web process permits automatic standby and has one-hour idle deletion. Deletion removes its preview URL. Environment changes require restarting the process; a new immutable image requires a fresh sandbox name. Obtain the current origin from the private host report rather than assuming an old preview remains available.

The [verification record](../../docs/verification.md) contains dated cloud-flow, browser and provider evidence, with exact images and limits. Purchases remain explicitly labeled Stripe test mode.
