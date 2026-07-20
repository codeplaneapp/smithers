export type GatewayBackoffOptions = {
  baseMs?: number;
  maxMs?: number;
  factor?: number;
  jitter?: number;
  random?: () => number;
};

/**
 * Computes an exponential backoff delay with full jitter for the given attempt
 * (0-based). The base delay grows by `factor` per attempt up to `maxMs`, then a
 * jitter fraction is applied symmetrically so concurrent clients do not
 * reconnect in lockstep.
 */
export function gatewayBackoffDelay(attempt: number, options: GatewayBackoffOptions = {}): number {
  const baseMs = options.baseMs ?? 250;
  const maxMs = options.maxMs ?? 10_000;
  const factor = options.factor ?? 2;
  const jitter = options.jitter ?? 0.5;
  const random = options.random ?? Math.random;
  const exponent = Math.max(0, attempt);
  const raw = Math.min(maxMs, baseMs * factor ** exponent);
  const spread = raw * jitter;
  const delta = (random() * 2 - 1) * spread;
  return Math.max(0, Math.round(raw + delta));
}
