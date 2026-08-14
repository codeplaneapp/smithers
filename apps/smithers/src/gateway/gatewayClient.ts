import { SmithersGatewayClient } from "@smthrs/gateway-client";

/**
 * The app's single gateway client.
 *
 * This is a LOCAL-ONLY UI: it always talks to a `smithers gateway` running on
 * the same origin (Vite proxies `/v1/api`, `/v1/rpc`, and `/health` to
 * `127.0.0.1:7331` in dev; in production the gateway/static server serves this
 * bundle from its own origin). There is no auth, no CSRF, no token — the gateway
 * binds loopback.
 *
 * The only transport concern we layer over the SDK is the WebSocket upgrade
 * path: the SDK opens the WS at the RPC base path, but the dev proxy only marks
 * `/v1/rpc` with `ws: true`, so we rewrite the upgrade pathname to `/v1/rpc`.
 * The gateway accepts a WS upgrade on any path, so this is transparent against
 * a direct gateway too.
 */
const RPC_WS_PATH = "/v1/rpc";

class RpcPathWebSocket extends WebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    const next = new URL(url);
    next.pathname = RPC_WS_PATH;
    next.search = "";
    super(next.toString(), protocols);
  }
}

/** Same-origin in the browser, loopback gateway otherwise (SSR/tests). */
function gatewayBaseUrl(): string {
  if (typeof location !== "undefined" && location.origin) return location.origin;
  return "http://127.0.0.1:7331";
}

let cached: SmithersGatewayClient | undefined;

export function getGatewayClient(): SmithersGatewayClient {
  if (!cached) {
    cached = new SmithersGatewayClient({
      baseUrl: gatewayBaseUrl(),
      WebSocket: RpcPathWebSocket,
    });
  }
  return cached;
}

/** Replace the shared client. `undefined` reverts to lazy resolution. Tests only. */
export function setGatewayClientForTests(client: SmithersGatewayClient | undefined): void {
  cached = client;
}

export { RPC_WS_PATH };
