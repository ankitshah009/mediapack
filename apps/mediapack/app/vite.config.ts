import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

// Standalone operator console. Served by the control service at /app/ from app/dist.
export default defineConfig({
  root,
  base: "/app/",
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    // `npm run dev:app` against a running control service on :3000
    proxy: { "/v1": "http://localhost:3000", "/viewer": "http://localhost:3000" },
  },
});
