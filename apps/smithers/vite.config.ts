import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { localFilesMiddleware } from "../cli/src/localUiServer.js";
import { localWorkspaceDevMiddleware } from "./src/app/localWorkspaceDevServer";
import { readLocalVcsSnapshot } from "./src/vcs/localAdapter";

/**
 * Local-only Smithers UI build.
 *
 * The app ALWAYS talks to a local `smithers gateway` (default
 * `http://127.0.0.1:7331`). It never reaches a cloud backend — there is no
 * auth, no jjhub/Plue REST, no Electric, no Cloudflare worker.
 *
 * The browser calls same-origin paths (`/v1/api/*`, `/v1/rpc/*`, `/health`,
 * `/workflows`). In dev Vite proxies them to the gateway, and in production the
 * gateway (or the `smithers ui` static server) serves this bundle from the same
 * origin so the same-origin calls land directly on the gateway. The WS upgrade
 * goes to `/v1/rpc` (see `src/gateway/gatewayClient.ts`), which the proxy
 * upgrades with `ws: true`; the gateway accepts a WS upgrade on any path.
 */
const gatewayTarget = process.env.SMITHERS_GATEWAY_PROXY_TARGET ?? "http://127.0.0.1:7331";
// The local concierge server owns `/api/chat` (the chat backend).
const conciergeTarget = process.env.SMITHERS_CONCIERGE_PROXY_TARGET ?? "http://127.0.0.1:5179";
const workspaceRoot = process.env.SMITHERS_WORKSPACE_ROOT ?? process.cwd();

function localVcsMiddleware() {
  return async (
    req: { url?: string },
    res: {
      statusCode: number;
      setHeader: (name: string, value: string) => void;
      end: (body: string) => void;
    },
    next: () => void,
  ) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/__smithers/vcs") {
      next();
      return;
    }
    try {
      const snapshot = await readLocalVcsSnapshot(workspaceRoot);
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(snapshot));
    } catch (error) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      );
    }
  };
}

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
  plugins: [
    react(),
    {
      name: "smithers-local-vcs",
      configureServer(server) {
        server.middlewares.use(localVcsMiddleware());
      },
      configurePreviewServer(server) {
        server.middlewares.use(localVcsMiddleware());
      },
    },
    {
      // Use the production CLI server's real filesystem implementation in dev
      // and e2e too, so the Files surface never needs a fabricated backend.
      name: "smithers-local-files",
      configureServer(server) {
        server.middlewares.use(localFilesMiddleware(workspaceRoot));
      },
      configurePreviewServer(server) {
        server.middlewares.use(localFilesMiddleware(workspaceRoot));
      },
    },
    {
      // The app gates on the local workspace contract (`WorkspacePicker`),
      // served in production by the CLI local UI server. Serve the same
      // endpoints in dev/preview or the app never gets past the picker.
      name: "smithers-local-workspace",
      configureServer(server) {
        server.middlewares.use(
          localWorkspaceDevMiddleware({
            serverWorkspaceRoot: workspaceRoot,
            gatewayBase: gatewayTarget,
          }),
        );
      },
      configurePreviewServer(server) {
        server.middlewares.use(
          localWorkspaceDevMiddleware({
            serverWorkspaceRoot: workspaceRoot,
            gatewayBase: gatewayTarget,
          }),
        );
      },
    },
  ],
  resolve: { dedupe },
  server: {
    host: "127.0.0.1",
    port: 5180,
    strictPort: false,
    proxy: {
      "/v1/api": { target: gatewayTarget, changeOrigin: true },
      "/v1/rpc": { target: gatewayTarget, changeOrigin: true, ws: true },
      "/health": { target: gatewayTarget, changeOrigin: true },
      "/workflows": { target: gatewayTarget, changeOrigin: true },
      "/api/chat": { target: conciergeTarget, changeOrigin: true },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4180,
    strictPort: false,
    proxy: {
      "/v1/api": { target: gatewayTarget, changeOrigin: true },
      "/v1/rpc": { target: gatewayTarget, changeOrigin: true, ws: true },
      "/health": { target: gatewayTarget, changeOrigin: true },
      "/workflows": { target: gatewayTarget, changeOrigin: true },
      "/api/chat": { target: conciergeTarget, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
