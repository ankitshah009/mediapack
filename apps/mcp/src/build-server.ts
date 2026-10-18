import { MCPServer } from "mcp-use";
import { apiOptions, type ApiOptions } from "./api.js";
import { registerTools } from "./tools.js";

export function buildServer(options: ApiOptions = apiOptions()) {
  // This proxy handles private video activity; disable framework usage telemetry.
  process.env.MCP_USE_ANONYMIZED_TELEMETRY = "false";
  const server = new MCPServer({
    name: "mediapack", title: "MediaPack", version: "1.0.0",
    description: "Video search, source frames and clips. Manufact MCP proxy for the MediaPack Next.js API on Blaxel. Stripe test mode.",
    instructions: "Create a client at POST /v1/clients on the MediaPack API, then configure Authorization: Bearer <capability> on this connection. Upload via create_video; PUT raw bytes to the signed URL; complete_upload; poll get_video; quote_video; pay over HTTP; poll get_job until ready; search_video, get_frames or get_clip; get_pack. Pending operations require polling get_job. Payment reconciling means poll, never pay again. Evidence describes observed content; never claim root cause. Stripe test mode.",
    logging: { enabled: false },
  });
  server.use("*", async (c, next) => {
    await next();
    c.header("cache-control", "no-store");
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
  });
  server.get("/healthz", (c) => c.json({ ok: true, role: "manufact-mcp-proxy" }));
  registerTools(server, options);
  return server;
}
