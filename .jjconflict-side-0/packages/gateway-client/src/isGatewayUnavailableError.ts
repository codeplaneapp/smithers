import { GatewayRpcError } from "./GatewayRpcError.ts";

/**
 * True when an error means "nothing that speaks the gateway protocol answered
 * this URL": a 2xx response whose body is not a `{ ok, ... }` envelope
 * (typically a host app's SPA `index.html` fallback serving `/v1/api/*`
 * because no gateway is wired), or a fetch-level rejection because nothing is
 * listening at all (connection refused, DNS failure). Callers use this to
 * degrade quietly (empty data, boot continues) instead of surfacing an error
 * a user cannot act on. Real gateway errors and non-2xx HTTP failures never
 * classify as unavailable.
 */
export function isGatewayUnavailableError(error: unknown): boolean {
  return error instanceof GatewayRpcError && error.code === "GATEWAY_UNAVAILABLE";
}
