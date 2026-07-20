import { useCallback, useRef, useState } from "react";
import { useSmithersGateway } from "./useSmithersGateway.ts";

/**
 * Imperative caller for an extension action (write-side RPC). Mirrors the
 * `useGatewayActions` shape: returns a stable `.call(...)` plus loading/error
 * state. A new call cancels the previous (via generation counter) so a fast
 * double-click cannot resolve out of order and leave stale error/data on
 * screen.
 */
export function useGatewayExtensionAction<TParams extends Record<string, unknown>, TPayload = unknown>(
  namespace: string,
  key: string,
) {
  const client = useSmithersGateway();
  const generationRef = useRef(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error>();
  const [data, setData] = useState<TPayload>();

  const call = useCallback(
    async (params: TParams): Promise<TPayload> => {
      const generation = ++generationRef.current;
      setPending(true);
      setError(undefined);
      try {
        const payload = await client.extensionRpc<TPayload>(namespace, key, params);
        if (generation === generationRef.current) {
          setData(payload);
          setPending(false);
        }
        return payload;
      } catch (cause) {
        if (generation === generationRef.current) {
          setError(cause instanceof Error ? cause : new Error(String(cause)));
          setPending(false);
        }
        throw cause;
      }
    },
    [client, namespace, key],
  );

  return { call, pending, error, data };
}
