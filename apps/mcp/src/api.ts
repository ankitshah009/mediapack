/** Manufact holds no MediaPack database, provider secrets, or per-user state. */
export type JsonObject = Record<string, unknown>;
export interface ToolContext {
  request?: { header(name: string): string | undefined };
  req?: { header(name: string): string | undefined };
  signal?: AbortSignal;
}

export class ApiError extends Error {
  constructor(public readonly body: JsonObject, public readonly status: number) {
    super("MediaPack API request failed");
  }
}

export function localError(code: string, message: string, next: string, retryable = false) {
  return { error: { code, message, retryable, next_action: next }, hint: message, next_action: next };
}

export function capabilityOf(ctx: ToolContext): string {
  const authorization = (ctx.request ?? ctx.req)?.header("authorization");
  const token = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? "")?.[1];
  if (!token) throw new ApiError(localError("UNAUTHORIZED", "Missing MediaPack capability.", "Create a client at POST /v1/clients on the MediaPack API, then configure this MCP connection with Authorization: Bearer <capability>."), 401);
  return token;
}

export interface ApiOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export function apiOptions(env: NodeJS.ProcessEnv = process.env): ApiOptions {
  const baseUrl = env.MEDIAPACK_API_URL ?? env.PUBLIC_BASE_URL;
  if (!baseUrl) throw new Error("Set MEDIAPACK_API_URL to the Next.js API origin hosted on Blaxel.");
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("MEDIAPACK_API_URL must be an HTTP(S) base URL without credentials, query, or fragment.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !loopback) throw new Error("MEDIAPACK_API_URL must use HTTPS unless it points to a loopback host; capabilities must not cross a remote network over HTTP.");
  const timeoutMs = Number(env.MEDIAPACK_API_TIMEOUT_MS ?? 20_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("MEDIAPACK_API_TIMEOUT_MS must be an integer from 1 to 120000.");
  return { baseUrl: url.toString().replace(/\/$/, ""), timeoutMs };
}

export function createApi(options: ApiOptions, ctx: ToolContext) {
  // Read the capability from this call only; never retain it in server/session state.
  const capability = capabilityOf(ctx);
  return async (path: string, body?: JsonObject) => {
    const signal = AbortSignal.timeout(options.timeoutMs ?? 20_000);
    const retry = typeof body?.request_id === "string" ? ` Retry using request_id ${body.request_id}.` : " Retry this same tool call.";
    let response: Response;
    let data: unknown;
    try {
      response = await (options.fetch ?? fetch)(`${options.baseUrl.replace(/\/$/, "")}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "X-MediaPack-Token": capability, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        cache: "no-store",
        redirect: "error",
        signal: ctx.signal ? AbortSignal.any([signal, ctx.signal]) : signal,
      });
      data = await response.json();
    } catch {
      // Do not relay fetch error text: it may contain a signed URL or request data.
      const timeout = signal.aborted;
      throw new ApiError(localError(timeout ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNAVAILABLE", timeout ? "The MediaPack API did not respond before the timeout." : "The MediaPack API is unavailable or returned an invalid JSON response.", `Check get_job/get_video for progress before submitting new work.${retry}`, true), 503);
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new ApiError(localError("UPSTREAM_INVALID_RESPONSE", "The MediaPack API returned an unexpected response shape.", "Check the Next.js API deployment and retry this call.", true), 502);
    if (!response.ok) throw new ApiError(data as JsonObject, response.status);
    return { body: data as JsonObject, status: response.status, retryAfter: response.headers.get("retry-after") };
  };
}
