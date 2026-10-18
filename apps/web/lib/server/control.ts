import "server-only";
import { buildHttpApp } from "../../../mediapack/src/http-app";

// A single in-process router shares the database pool and adapters across Next.js requests.
let control: ReturnType<typeof buildHttpApp> | undefined;

export async function handleControl(request: Request): Promise<Response> {
  try {
    control ??= buildHttpApp();
    return await control.app.fetch(request);
  } catch (error) {
    // Configuration errors are actionable but never expose credentials or raw provider responses.
    const { toAppError } = await import("../../../mediapack/src/services/errors");
    const e = toAppError(error);
    return Response.json(e.body(), { status: e.status, headers: { "cache-control": "no-store" } });
  }
}
