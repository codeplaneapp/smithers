import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dev server runs inside the WebContainer. The page reaches it through a
// generated preview hostname, so host checking must be off, and the gateway is
// proxied so the app can use a same-origin base URL instead of fighting CORS
// across two preview origins.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      "/v1": { target: "http://127.0.0.1:7331", changeOrigin: true, ws: true },
      "/rpc": { target: "http://127.0.0.1:7331", changeOrigin: true, ws: true },
    },
  },
});
