import { useEffect, useMemo, useState } from "react";
import { gatewayBackoffDelay, type GatewayBackoffOptions } from "@smithers-orchestrator/gateway-client";
import { useSmithersGateway } from "./useSmithersGateway.ts";

const DEFAULT_MAX_FRAMES = 1000;

export type GatewayExtensionStreamState<T> = {
  frames: T[];
  latest: T | undefined;
  error: Error | undefined;
  streaming: boolean;
};

/**
 * Subscribe to an extension stream and reflect frames into React state. Bounded
 * by `maxFrames` (default 1000) so a chatty extension cannot OOM the UI; the
 * window slides forward, dropping the oldest frame.
 *
 * Reconnect/resume:
 * - A network drop (the underlying WS closing without the run ending) triggers
 *   exponential backoff with jitter, then resubscribes with the same params.
 * - The extension `subscribe()` handler is responsible for honoring a
 *   `params.afterSeq` (or extension-specific cursor) in its replay; the client
 *   has no way to replay frames the server hasn't kept.
 * - Stale frames are fenced: a re-render that changes `(namespace, key, params)`
 *   aborts the prior subscription via its `AbortController`, so frames from it
 *   that arrive late are ignored.
 *
 * Slow-consumer backpressure: the server already enforces a per-connection
 * outbound queue; if the React app falls behind the gateway's bound, the gateway
 * closes the connection with `BackpressureDisconnect`. We surface that as an
 * error and the backoff loop will retry.
 */
export function useGatewayExtensionStream<T = unknown>(
  namespace: string | undefined,
  key: string | undefined,
  params: Record<string, unknown> = {},
  options: { maxFrames?: number; enabled?: boolean; backoff?: GatewayBackoffOptions } = {},
): GatewayExtensionStreamState<T> {
  const client = useSmithersGateway();
  const enabled = options.enabled ?? Boolean(namespace && key);
  const maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES;
  const paramsKey = useMemo(() => JSON.stringify(params ?? {}), [params]);
  // Stabilize `options.backoff` via a string key so callers passing a fresh
  // object literal each render don't tear down + resubscribe on every render.
  // The string covers all fields the backoff helper reads so any meaningful
  // change still re-runs the effect.
  const backoffKey = useMemo(() => JSON.stringify(options.backoff ?? null), [options.backoff]);

  const [frames, setFrames] = useState<T[]>([]);
  const [latest, setLatest] = useState<T>();
  const [error, setError] = useState<Error>();
  const [streaming, setStreaming] = useState(false);

  useEffect(() => {
    if (!enabled || !namespace || !key) {
      setStreaming(false);
      return;
    }
    const abort = new AbortController();
    setFrames([]);
    setLatest(undefined);
    setError(undefined);
    setStreaming(true);
    let attempt = 0;
    void (async () => {
      while (!abort.signal.aborted) {
        try {
          for await (const frame of client.streamExtension<T>(namespace, key, params, {
            signal: abort.signal,
          })) {
            attempt = 0;
            // Recovered: a frame arrived, so clear any error from a prior
            // failed attempt instead of leaving it stuck after reconnect.
            setError(undefined);
            setLatest(frame);
            setFrames((current) => {
              if (current.length >= maxFrames) {
                const next = current.slice(current.length - maxFrames + 1);
                next.push(frame);
                return next;
              }
              return [...current, frame];
            });
          }
        } catch (cause) {
          if (abort.signal.aborted) {
            return;
          }
          setError(cause instanceof Error ? cause : new Error(String(cause)));
        }
        if (abort.signal.aborted) {
          return;
        }
        // Wait + reconnect. Server-side `subscribe()` decides whether replay
        // happens on resume — clients can't fake durability from this side.
        // The wait is abort-aware so an unmount/dep-change during backoff
        // resolves immediately instead of blocking on a stale timer.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, gatewayBackoffDelay(attempt, options.backoff));
          abort.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        attempt += 1;
      }
    })().finally(() => {
      if (!abort.signal.aborted) {
        setStreaming(false);
      }
    });
    return () => abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, enabled, namespace, key, paramsKey, maxFrames, backoffKey]);

  return { frames, latest, error, streaming };
}
