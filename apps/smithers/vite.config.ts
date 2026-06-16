import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

// During e2e the chat gateway (the Cloudflare Worker that owns POST /api/chat)
// runs as its own process on a separate port, pointed at a local deterministic
// OpenAI-compatible upstream. Vite proxies the browser's same-origin /api/chat
// call to it so the app's real fetch path hits a live Worker with NO route
// mocking. Outside e2e (env unset) nothing is proxied and /api/chat 404s under
// `vite dev` exactly as before.
const chatTarget = process.env.SMITHERS_CHAT_PROXY_TARGET;

const proxy: Record<string, string | ProxyOptions> = {};

function proxyTo(target: string): ProxyOptions {
  return { target, changeOrigin: true };
}

if (chatTarget) {
  proxy["/api/chat"] = {
    target: chatTarget,
    changeOrigin: true,
    headers: { origin: chatTarget },
  };
  // Same-origin `/metrics` proxy so e2e and local dev can scrape the Worker's
  // Prometheus exposition without crossing the Worker's same-origin guard.
  proxy["/metrics"] = {
    target: chatTarget,
    changeOrigin: true,
    headers: { origin: chatTarget },
  };
}

const authTarget = process.env.SMITHERS_AUTH_PROXY_TARGET;
const explicitPlatformTarget = process.env.SMITHERS_PLATFORM_PROXY_TARGET;
const platformTarget = explicitPlatformTarget ?? authTarget;

const platformUserProxyPrefixes = [
  "/api/user/repos",
  "/api/user/readable-repos",
  "/api/user/workspaces",
  "/api/user/orgs",
  "/api/user/starred",
  "/api/user/issues",
  "/api/user/landings",
  "/api/user/notifications",
  "/api/user/subscriptions",
  "/api/user/following",
  "/api/user/followers",
  "/api/user/searches",
];

if (authTarget && platformTarget && platformTarget !== authTarget) {
  for (const prefix of platformUserProxyPrefixes) {
    proxy[prefix] = proxyTo(platformTarget);
  }
}

// Optional Plue-compatible auth API for local remote-mode development. The
// deployed Worker owns this proxy in production; Vite mirrors it for dev and
// preview when pointed at a sibling/local Plue API.
if (authTarget) {
  proxy["/api/auth"] = proxyTo(authTarget);
  proxy["/api/user"] = proxyTo(authTarget);
}

// Optional Plue/jjhub platform REST API. With only SMITHERS_PLATFORM_PROXY_TARGET
// set, this commonly points at the local Worker host, which owns every /api/*
// route and performs the real auth/platform split internally. With both auth
// and platform targets set, Vite mirrors that split directly by routing the
// known /api/user/<platform-subpath> prefixes before the auth /api/user prefix.
if (platformTarget) {
  if (!authTarget) {
    proxy["/api/user"] = proxyTo(platformTarget);
  }
  proxy["/api/repos"] = proxyTo(platformTarget);
  proxy["/api/orgs"] = proxyTo(platformTarget);
  proxy["/api/issues"] = proxyTo(platformTarget);
  proxy["/api/landings"] = proxyTo(platformTarget);
  proxy["/api/workspaces"] = proxyTo(platformTarget);
  proxy["/api/notifications"] = proxyTo(platformTarget);
  proxy["/api/search"] = proxyTo(platformTarget);
  proxy["/api/integrations"] = proxyTo(platformTarget);
  proxy["/api/oauth2"] = proxyTo(platformTarget);
  proxy["/resolve"] = proxyTo(platformTarget);
}

// A connected Smithers gateway (its own process: `smithers up` on
// 127.0.0.1:7331, or the e2e fixture). The app's gateway client and the embedded
// custom-UI iframes call same-origin paths; proxy them to the gateway so the
// browser's real fetch / iframe path runs with NO mocking.
const gatewayTarget = process.env.SMITHERS_GATEWAY_PROXY_TARGET;
if (gatewayTarget) {
  proxy["/v1/rpc"] = { target: gatewayTarget, changeOrigin: true, ws: true };
  proxy["/health"] = proxyTo(gatewayTarget);
  proxy["/workflows"] = proxyTo(gatewayTarget);
}

export default defineConfig({
  plugins: [react()],
  // No cross-origin-isolation headers (COOP/COEP). The Phase 2 web persistence
  // adapter is async OPFS-JSON (`opfsJsonPersistenceAdapter`), which needs no
  // SharedArrayBuffer and so no cross-origin isolation. Real SQLite-WASM/OPFS
  // (which does need COI) is deferred (design §5.4, risk §11.2); adding
  // `require-corp` here prematurely blocks the same-origin custom-workflow-UI
  // iframe (`/workflows/<key>`) with ERR_BLOCKED_BY_RESPONSE. Reintroduce these
  // headers alongside CORP on the gateway-served bundle when SQLite-WASM lands.
  server: {
    host: "127.0.0.1",
    port: 5175,
    strictPort: false,
    proxy,
  },
  preview: {
    host: "127.0.0.1",
    port: 4175,
    strictPort: false,
    proxy,
  },
});
