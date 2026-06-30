import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Local-only Smithers UI build.
 *
 * The app ALWAYS talks to a local `smithers gateway` (default
 * `http://127.0.0.1:7331`). It never reaches a cloud backend — there is no
 * auth, no jjhub/Plue REST, no Electric, no Cloudflare worker.
 *
 * The browser calls same-origin paths (`/v1/rpc/*`, `/health`, `/workflows`);
 * in dev Vite proxies them to the gateway, and in production the gateway (or
 * the `smithers ui` static server) serves this bundle from the same origin so
 * the same-origin calls land directly on the gateway. The WS upgrade goes to
 * `/v1/rpc` (see `src/gateway/gatewayClient.ts`), which the proxy upgrades with
 * `ws: true`; the gateway accepts a WS upgrade on any path.
 */
const gatewayTarget = process.env.SMITHERS_GATEWAY_PROXY_TARGET ?? "http://127.0.0.1:7331";

// One instance of each of these must exist across the app AND the linked
// gateway packages, or `useLiveQuery` subscribes to a different module's
// collection registry and silently renders no data.
const dedupe = [
  "react",
  "react-dom",
  "@tanstack/db",
  "@tanstack/react-db",
  "@smithers-orchestrator/gateway-client",
  "@smithers-orchestrator/gateway-react",
];

export default defineConfig({
  plugins: [react()],
  resolve: { dedupe },
  server: {
    host: "127.0.0.1",
    port: 5180,
    strictPort: false,
    proxy: {
      "/v1/rpc": { target: gatewayTarget, changeOrigin: true, ws: true },
      "/health": { target: gatewayTarget, changeOrigin: true },
      "/workflows": { target: gatewayTarget, changeOrigin: true },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4180,
    strictPort: false,
    proxy: {
      "/v1/rpc": { target: gatewayTarget, changeOrigin: true, ws: true },
      "/health": { target: gatewayTarget, changeOrigin: true },
      "/workflows": { target: gatewayTarget, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
