# MediaPack shared backend

`src/` contains the contracts, Postgres services, provider adapters, and Hono HTTP router used in-process by the [Next.js application](../web/README.md). Next.js owns the production HTTP listener on Blaxel. The independent [MCP proxy](../mcp/README.md) runs on Manufact.

## Layout

| Path | Responsibility |
| --- | --- |
| `src/contracts/` | Request, result, allowance and worker message schemas |
| `src/services/` | Ownership, uploads, purchases, durable operations, outbox and recovery |
| `src/adapters/` | Stripe, Primitive, Supabase Storage and Blaxel I/O |
| `src/routes/` | REST, browser sessions, webhooks and internal routes |
| `src/http-app.ts` | Router construction imported by Next.js |
| `tests/` | Configuration, SDK boundary and transaction/integration checks |

`index.ts`, `app/` and `views/` retain the earlier combined mcp-use/Vite implementation. Their package scripts serve that prototype; current deployment entry points are `apps/web` and `apps/mcp`.

## Install and test

Use Node 22.22.2 or newer:

```sh
npm ci
npm test
```

Integration tests use a disposable local Postgres and replace external provider I/O at adapter boundaries. They do not perform a live purchase. The independent SQL invariant suite runs from the repository root with `bash scripts/test-db.sh`.

Database migrations live in [`../../supabase/migrations`](../../supabase/migrations). The [Supabase setup helper](../../scripts/setup-supabase.mjs) applies them with transaction and checksum protection to an already-provisioned project. Never run the scratch invariant suite against a live application database.

Server configuration belongs to the Next.js app's private environment file. See the [root README](../../README.md), [account setup](../../docs/SETUP-ACCOUNTS.md), [wire contract](../../CONTRACTS.md) and [release checks](../../docs/RELEASE-CHECKLIST.md).
