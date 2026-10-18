# MediaPack MCP on Manufact

This independent `mcp-use` 2.10.1 service runs on **Manufact**. It forwards tools to the canonical **Next.js dashboard and REST API hosted on Blaxel**. Blaxel also runs the media workers. The Next.js API owns authentication, payment verification, allowance enforcement and persistence.

The proxy needs only `MEDIAPACK_API_URL` (or `PUBLIC_BASE_URL`) and an optional `MEDIAPACK_API_TIMEOUT_MS` (default 20000). It has no database connection, Stripe/Primitive/Blaxel credentials, service-wide user capability, media cache, or payload logging. Framework usage telemetry is disabled. Each MCP call forwards that request's `Authorization: Bearer <capability>` as `X-MediaPack-Token`. Outbound requests have a timeout, disable caching and reject redirects so capabilities are not forwarded to another origin.

The configured API URL must use HTTPS. Plain HTTP is accepted only for `localhost`, `127.0.0.1`, or `[::1]` during local development.

## Run locally

Use Node >=22.22.2. Start the Next.js API separately, then:

```sh
cd apps/mcp
npm ci
cp .env.example .env
# Set MEDIAPACK_API_URL to the local Next.js API, for example http://localhost:3000.
npm run dev
```

The dev CLI shows its endpoint and Inspector URL; avoid using the same port as Next.js. For a fixed production listener:

```sh
npm run build
npm start -- --port 3001
```

Health: `GET http://localhost:3001/healthz`. MCP: `http://localhost:3001/mcp`. The server never binds or makes external API calls during import/build.

Create a client using `POST /v1/clients` on the **Next.js API** and configure the MCP connection with `Authorization: Bearer <the returned capability>`. Treat that capability like a password. A token is checked against the Next.js API on every call; the proxy cannot bypass ownership checks.

## Tools and REST mapping

| Tool | Next.js API request |
| --- | --- |
| `create_video` | `POST /v1/videos` |
| `complete_upload` | `POST /v1/videos/:video_id/complete` |
| `get_video` | `GET /v1/videos/:video_id` |
| `quote_video` | `POST /v1/videos/:video_id/quotes` |
| `get_job` | `GET /v1/jobs/:job_id` |
| `search_video` | `POST /v1/jobs/:job_id/searches` |
| `get_frames` | `POST /v1/jobs/:job_id/frames` |
| `get_clip` | `POST /v1/jobs/:job_id/clips` |
| `get_pack` | `GET /v1/jobs/:job_id/pack` |

The upload is a direct PUT to the returned signed upload URL. Payment remains an HTTP flow on the API purchase URL. The proxy performs neither upload nor payment itself. Stripe test mode is labeled in instructions, quotes and the MCP App result view.

Pass a caller-generated `request_id` to `create_video` and retain it until the response arrives. Search/frame/clip calls derive the same deterministic retry IDs as the original tools when no ID is supplied. Explicit IDs always pass through unchanged. There are no automatic mutation retries. If a network failure occurs after a create was sent, the error includes the generated request ID so the caller can reuse it.

Pending operations return their operation ID, state and `retry_after_seconds`; poll `get_job`. Payment `reconciling` also means poll, never pay again. Upstream error bodies are returned unchanged as `structuredContent` with MCP `isError: true`.

Successful frame/clip calls, and succeeded operations in `get_job`, resolve artifact URLs through the authenticated API `/v1/artifacts/:artifact_id/access`. The MCP proxy does not fetch media bytes or send capabilities to storage hosts. Expiring signed URLs remain in that call's response only. Use `get_pack` to refresh access later.

Exactly one MCP App view is bound, to `get_job`; it renders the API's persisted job state, latest search, source evidence and remaining allowance. The view is bundled into the production build and has no dependency on the old dashboard source.

## Deploy to Manufact

Deployment commands below were checked against installed `mcp-use deploy --help` (CLI 4.4.1 from mcp-use 2.10.1). The project has not been deployed automatically.

For a GitHub deployment from this monorepo, run in `apps/mcp` after setting the API URL in a local `.env.production` file:

```sh
npm run deploy -- --root-dir apps/mcp --env-file .env.production
```

The default GitHub mode uses the existing origin. If no origin exists, the CLI can offer to create a private repository. For a managed source upload of this self-contained directory:

```sh
npm run deploy -- --no-github --env-file .env.production
```

Do not put provider secrets or user capabilities in that environment file. Keep the emitted Manufact `/mcp` URL for agent connections and configure each client's authorization header independently. The server listens on `0.0.0.0` and respects Manufact's `PORT` through `mcp-use start`.

## Verify

```sh
npm run typecheck
npm test
npm run build
npm run test:runtime
```

Tests exercise the real MCP transport and mock only the outbound HTTP boundary. They cover per-request capability isolation, REST bodies and retry IDs, asynchronous pending results, preservation of upstream errors, authorized artifact URLs, timeouts and sanitized network failures. After building, `test:runtime` starts a fresh production CLI listener and local HTTP fixture, exercises health, tools and bundled view resources, then stops both processes. It needs permission to bind loopback ports in restricted sandboxes.
