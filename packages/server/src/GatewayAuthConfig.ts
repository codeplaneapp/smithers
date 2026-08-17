import type { GatewayTokenGrant } from "./GatewayTokenGrant.js";

export type GatewayAuthConfig =
  | {
      mode: "token";
      tokens: Record<string, GatewayTokenGrant>;
      /**
       * Optional Origin allow-list (defense-in-depth). When non-empty, a request
       * or WS upgrade carrying a browser `Origin` header not on the list is
       * rejected; requests with no `Origin` (server-to-server / CLI) are allowed.
       * Unset/empty preserves the prior allow-all behavior.
       */
      allowedOrigins?: string[];
    }
  | {
      mode: "jwt";
      issuer: string;
      audience: string | string[];
      secret: string;
      scopesClaim?: string;
      roleClaim?: string;
      userClaim?: string;
      /** JWT claim containing the application key (default: `app`). */
      appClaim?: string;
      defaultRole?: string;
      defaultScopes?: string[];
      clockSkewSeconds?: number;
      /**
       * Optional Origin allow-list (defense-in-depth). When non-empty, a request
       * or WS upgrade carrying a browser `Origin` header not on the list is
       * rejected; requests with no `Origin` (server-to-server / CLI) are allowed.
       * Unset/empty preserves the prior allow-all behavior.
       */
      allowedOrigins?: string[];
    }
  | {
      mode: "trusted-proxy";
      /**
       * Transport-level trust boundary. Required and non-empty: trusted-proxy
       * mode authenticates from client-supplied identity headers, so the
       * gateway only honors them when the immediate socket peer matches one of
       * these entries. Each entry is an IP literal (`"10.0.0.7"`, `"::1"`), a
       * CIDR block (`"10.0.0.0/24"`), or the literal `"unix"` for a
       * Unix-domain listener. The peer is the transport peer — never
       * `X-Forwarded-For` — so behind a proxy chain list only the last hop.
       * Startup fails when this is missing, empty, malformed, or cannot apply
       * to the socket the gateway binds.
       */
      trustedProxies: string[];
      /** Identity, scopes, role, and application headers, in that order. */
      trustedHeaders?: string[];
      allowedOrigins?: string[];
      defaultRole?: string;
      defaultScopes?: string[];
    };
