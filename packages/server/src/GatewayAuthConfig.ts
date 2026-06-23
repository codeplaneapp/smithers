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
      trustedHeaders?: string[];
      allowedOrigins?: string[];
      defaultRole?: string;
      defaultScopes?: string[];
    };
