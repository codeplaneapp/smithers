/**
 * Resolve the gateway base URL + port for `smithers-mon` from (in priority order)
 * the `--gateway`/`--port` args, the `SMITHERS_GATEWAY_URL`/`SMITHERS_GATEWAY_PORT`
 * env vars, then the local default. Extracted as a pure function so the arg/env
 * precedence is unit-testable without importing the bin entry (which runs TTY
 * checks + `process.exit` at module top level).
 *
 * `autoStartAllowed` is true ONLY for the implicit/default local path: the user
 * did not pin a gateway via `--gateway` or `SMITHERS_GATEWAY_URL`. When the user
 * points us at an explicit gateway that is unreachable, autostarting a detached
 * LOCAL gateway would spawn a process the monitor never connects to.
 *
 * An explicit `--port` is always applied to the resolved base URL: pinning a
 * gateway host without a port (or with a different port) plus `--port` must
 * probe/connect on the requested port, not the URL's original one.
 */

export const DEFAULT_GATEWAY_PORT = 7331;

/**
 * True when `value` is a legal TCP port to CONNECT to: an integer in 1..65535.
 * Port 0 ("let the OS pick") is meaningless for a client dialing a fixed
 * gateway, so it is rejected alongside NaN, fractions, and out-of-range values.
 * Shared by the `--port` arg check and the `SMITHERS_GATEWAY_PORT` env parse so
 * both paths agree on what a valid port is.
 */
export function isValidGatewayPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

/** Thrown by `resolveGatewayConfig` for a set-but-invalid `SMITHERS_GATEWAY_PORT`. */
export class GatewayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayConfigError";
  }
}

/**
 * Parse `SMITHERS_GATEWAY_PORT`: `undefined` when unset/blank (caller falls back
 * to `DEFAULT_GATEWAY_PORT`), the integer when it is a legal port, and a thrown
 * `GatewayConfigError` otherwise — so `SMITHERS_GATEWAY_PORT=70000` fails loudly
 * instead of building an unreachable `http://127.0.0.1:70000` the monitor can
 * never connect to.
 */
export function parseGatewayPortEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const port = Number(raw);
  if (!isValidGatewayPort(port)) {
    throw new GatewayConfigError(
      `invalid SMITHERS_GATEWAY_PORT "${raw}" (expected an integer 1-65535)`,
    );
  }
  return port;
}

export interface ResolveGatewayConfigInput {
  gatewayUrlArg?: string | undefined;
  portArg?: number | undefined;
  tokenArg?: string | undefined;
  env?: Record<string, string | undefined>;
}

export interface GatewayConfig {
  base: string;
  port: number;
  autoStartAllowed: boolean;
  /**
   * Bearer token for HTTP + WS auth, resolved (in priority order) from the
   * `--token` arg, then `SMITHERS_TOKEN`, then `SMITHERS_API_KEY` (the same env
   * var the gateway itself reads to require auth). `undefined` when none is set,
   * so a loopback gateway with no auth stays token-free.
   */
  token?: string;
}

/**
 * Resolve the bearer token the monitor authenticates with. `SMITHERS_API_KEY`
 * is the env var the gateway reads to enable token auth, so when it is set the
 * client MUST send the same token or every RPC/WS call is rejected while
 * `/health` (unauthenticated) still passes.
 */
function resolveToken(
  tokenArg: string | undefined,
  env: Record<string, string | undefined>,
): string | undefined {
  const token = tokenArg ?? env.SMITHERS_TOKEN ?? env.SMITHERS_API_KEY;
  return token && token.length > 0 ? token : undefined;
}

export function resolveGatewayConfig({
  gatewayUrlArg,
  portArg,
  tokenArg,
  env = {},
}: ResolveGatewayConfigInput): GatewayConfig {
  const token = resolveToken(tokenArg, env);
  const fromArgOrEnv = gatewayUrlArg ?? env.SMITHERS_GATEWAY_URL;
  if (fromArgOrEnv) {
    let base = fromArgOrEnv.replace(/\/+$/, "");
    let port = portArg;
    if (port === undefined) {
      try {
        port = Number(new URL(base).port) || DEFAULT_GATEWAY_PORT;
      } catch {
        port = DEFAULT_GATEWAY_PORT;
      }
    } else {
      // An explicit --port overrides whatever port the pinned URL carried (or
      // supplies one when it had none), so probe/client target the requested
      // port instead of silently ignoring it.
      try {
        const url = new URL(base);
        url.port = String(port);
        base = url.toString().replace(/\/+$/, "");
      } catch {
        // `base` isn't a full URL (shouldn't happen for a real gateway); leave
        // it untouched and fall back to the requested port for the probe.
      }
    }
    return { base, port, autoStartAllowed: false, token };
  }
  const port = portArg ?? parseGatewayPortEnv(env.SMITHERS_GATEWAY_PORT) ?? DEFAULT_GATEWAY_PORT;
  return { base: `http://127.0.0.1:${port}`, port, autoStartAllowed: true, token };
}
