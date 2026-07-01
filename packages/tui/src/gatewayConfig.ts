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

export interface ResolveGatewayConfigInput {
  gatewayUrlArg?: string | undefined;
  portArg?: number | undefined;
  env?: Record<string, string | undefined>;
}

export interface GatewayConfig {
  base: string;
  port: number;
  autoStartAllowed: boolean;
}

export function resolveGatewayConfig({
  gatewayUrlArg,
  portArg,
  env = {},
}: ResolveGatewayConfigInput): GatewayConfig {
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
    return { base, port, autoStartAllowed: false };
  }
  const port = portArg ?? (Number(env.SMITHERS_GATEWAY_PORT) || DEFAULT_GATEWAY_PORT);
  return { base: `http://127.0.0.1:${port}`, port, autoStartAllowed: true };
}
