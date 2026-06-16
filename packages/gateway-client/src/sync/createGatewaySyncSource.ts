import type { CollectionConfig } from "@tanstack/db";
import type { CollectionDef } from "./CollectionDef.ts";
import type { SyncSource } from "./SyncSource.ts";
import type { SyncKey } from "./SyncKey.ts";
import { syncKeyFingerprint, syncKeyMatches } from "./SyncKey.ts";
import type { SyncStreamFrame, SyncStreamOptions, SyncTransport } from "./SyncTransport.ts";
import { createConnectionObserver } from "./createConnectionObserver.ts";
import { createGatewayCollection } from "./createGatewayCollection.ts";

type GatewaySyncSourceOptions = {
  transport: SyncTransport;
  onAuthError?: (error: Error) => void;
  onCollectionError?: (id: string, error: Error) => void;
  onCollectionReady?: (id: string) => void;
};

type GatewaySyncSource = SyncSource & {
  client: SyncTransport;
  invalidate(prefix: SyncKey): void;
};

const INVALIDATE_SCOPE = "smithers:invalidate";

function isAuthError(error: unknown): boolean {
  const record = error as { code?: unknown; status?: unknown } | undefined;
  const code = typeof record?.code === "string" ? record.code : "";
  const status = typeof record?.status === "number" ? record.status : undefined;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return status === 401 ||
    status === 403 ||
    /^(UNAUTHORIZED|Unauthorized|FORBIDDEN|Forbidden)\b/.test(message) ||
    /^(Unauthorized|Forbidden)$/i.test(code);
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function createPulser() {
  const waiters = new Map<string, Set<() => void>>();
  return {
    pulse(fingerprint: string) {
      const set = waiters.get(fingerprint);
      if (!set || set.size === 0) return;
      const pending = Array.from(set);
      set.clear();
      for (const resolve of pending) resolve();
    },
    stream(fingerprint: string, signal: AbortSignal): AsyncIterable<SyncStreamFrame> {
      return {
        async *[Symbol.asyncIterator]() {
          while (!signal.aborted) {
            await new Promise<void>((resolve) => {
              if (signal.aborted) {
                resolve();
                return;
              }
              const set = waiters.get(fingerprint) ?? new Set();
              set.add(resolve);
              waiters.set(fingerprint, set);
              signal.addEventListener(
                "abort",
                () => {
                  set.delete(resolve);
                  resolve();
                },
                { once: true },
              );
            });
            if (signal.aborted) return;
            yield { key: ["smithers:invalidate", fingerprint], event: "invalidate", payload: undefined };
          }
        },
      };
    },
  };
}

export function createGatewaySyncSource(options: GatewaySyncSourceOptions): GatewaySyncSource {
  const connection = createConnectionObserver();
  const pulser = createPulser();
  const invalidators = new Map<string, { key: SyncKey; run: () => void }>();
  const base = options.transport;

  const transport: SyncTransport = {
    async rpc(method, params, opts) {
      connection.markConnecting();
      try {
        const result = await base.rpc(method, params, opts);
        connection.markOnline();
        return result;
      } catch (cause) {
        const error = asError(cause);
        if (isAuthError(error)) {
          connection.markUnauthorized();
          options.onAuthError?.(error);
        } else {
          connection.markOffline();
        }
        throw error;
      }
    },
    stream(scope, params, streamOptions: SyncStreamOptions) {
      if (scope === INVALIDATE_SCOPE) {
        const fingerprint = typeof params === "string"
          ? params
          : String((params as { fingerprint?: unknown })?.fingerprint ?? "");
        const signal = streamOptions.signal ?? new AbortController().signal;
        return pulser.stream(fingerprint, signal);
      }
      if (!base.stream) {
        throw new Error("Gateway transport has no stream implementation.");
      }
      const upstream = base.stream;
      return {
        async *[Symbol.asyncIterator]() {
          connection.markConnecting();
          try {
            for await (const frame of upstream(scope, params, streamOptions)) {
              connection.markOnline();
              yield frame;
            }
          } catch (cause) {
            const error = asError(cause);
            if (isAuthError(error)) {
              connection.markUnauthorized();
              options.onAuthError?.(error);
            } else {
              connection.markOffline();
            }
            throw error;
          }
        },
      };
    },
  };

  return {
    client: transport,
    collection<TRow extends object, TKey extends string | number>(
      def: CollectionDef<TRow, TKey>,
    ): CollectionConfig<TRow, TKey> {
      const id = syncKeyFingerprint(def.key);
      const pollable = def.gateway.stream === undefined;
      if (pollable && !invalidators.has(id)) {
        invalidators.set(id, { key: def.key, run: () => pulser.pulse(id) });
      }
      const stream = def.gateway.stream
        ? {
            ...def.gateway.stream,
            ...(def.maxRows !== undefined && def.gateway.stream.maxRows === undefined ? { maxRows: def.maxRows } : {}),
          }
        : {
            scope: INVALIDATE_SCOPE,
            params: { fingerprint: id },
            refetchOnFrame: true,
            refetchMode: "replace" as const,
            reconnectOnGracefulEnd: false,
            ...(def.maxRows !== undefined ? { maxRows: def.maxRows } : {}),
          };
      return createGatewayCollection<TRow, TKey>({
        key: def.key,
        client: transport,
        getKey: def.getKey,
        startSync: false,
        ...(def.gateway.method ? { method: def.gateway.method } : {}),
        ...(def.gateway.params === undefined ? {} : { params: def.gateway.params }),
        ...(def.gateway.rows ? { rows: def.gateway.rows } : {}),
        stream,
        onAuthError: options.onAuthError,
        onError: (error) => options.onCollectionError?.(id, error),
        onReady: () => options.onCollectionReady?.(id),
      });
    },
    status: () => connection,
    invalidate(prefix: SyncKey) {
      for (const { key, run } of invalidators.values()) {
        if (syncKeyMatches(key, prefix)) run();
      }
    },
    reset() {
      invalidators.clear();
      connection.reset();
    },
  };
}
