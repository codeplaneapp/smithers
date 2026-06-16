import type { CollectionConfig } from "@tanstack/db";
import type { CollectionDef } from "./CollectionDef.ts";
import type { SyncSource, SyncSourceWriteRequest } from "./SyncSource.ts";
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
  commit<TData>(request: SyncSourceWriteRequest<unknown>): Promise<TData>;
  confirm(prefix: SyncKey): Promise<void>;
};

const INVALIDATE_SCOPE = "smithers:invalidate";
/** Safety bound for an awaited confirm refetch (a live sync resolves in ms). */
const CONFIRM_REFETCH_TIMEOUT_MS = 10_000;

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
  // A pulse with no current waiter is remembered and delivered to the next
  // subscriber. Without this a pulse fired while the stream loop is mid-refetch
  // (between awaits) would be lost, so an awaited confirm could hang on a
  // refetch that never runs.
  const pending = new Set<string>();
  return {
    pulse(fingerprint: string) {
      const set = waiters.get(fingerprint);
      if (!set || set.size === 0) {
        pending.add(fingerprint);
        return;
      }
      const resolvers = Array.from(set);
      set.clear();
      for (const resolve of resolvers) resolve();
    },
    stream(fingerprint: string, signal: AbortSignal, pollMs?: number): AsyncIterable<SyncStreamFrame> {
      return {
        async *[Symbol.asyncIterator]() {
          while (!signal.aborted) {
            if (pending.has(fingerprint)) {
              pending.delete(fingerprint);
            } else {
              await new Promise<void>((resolve) => {
                if (signal.aborted) {
                  resolve();
                  return;
                }
                let timer: ReturnType<typeof setTimeout> | undefined;
                const set = waiters.get(fingerprint) ?? new Set();
                const done = () => {
                  if (timer) clearTimeout(timer);
                  set.delete(done);
                  resolve();
                };
                set.add(done);
                waiters.set(fingerprint, set);
                if (pollMs !== undefined && Number.isFinite(pollMs) && pollMs > 0) {
                  timer = setTimeout(done, pollMs);
                }
                signal.addEventListener(
                  "abort",
                  () => {
                    done();
                  },
                  { once: true },
                );
              });
              if (signal.aborted) return;
            }
            yield { key: ["smithers:invalidate", fingerprint], event: "invalidate", payload: undefined };
          }
        },
      };
    },
  };
}

/**
 * Resolves the next time `signal()` is called for an id, or after a timeout.
 * The write path registers a waiter, pulses the collection, and awaits this so
 * the confirmed refetch is buffered before the optimistic transaction completes.
 */
function createRefetchWaiters() {
  const waiters = new Map<string, Set<() => void>>();
  return {
    signal(id: string) {
      const set = waiters.get(id);
      if (!set || set.size === 0) return;
      const resolvers = Array.from(set);
      set.clear();
      for (const resolve of resolvers) resolve();
    },
    wait(id: string, timeoutMs: number): Promise<void> {
      return new Promise<void>((resolve) => {
        const set = waiters.get(id) ?? new Set<() => void>();
        const done = () => {
          clearTimeout(timer);
          set.delete(done);
          resolve();
        };
        const timer = setTimeout(done, timeoutMs);
        set.add(done);
        waiters.set(id, set);
      });
    },
  };
}

export function createGatewaySyncSource(options: GatewaySyncSourceOptions): GatewaySyncSource {
  const connection = createConnectionObserver();
  const pulser = createPulser();
  const refetchWaiters = createRefetchWaiters();
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
        const pollMs = typeof (params as { pollMs?: unknown })?.pollMs === "number"
          ? (params as { pollMs: number }).pollMs
          : undefined;
        const signal = streamOptions.signal ?? new AbortController().signal;
        return pulser.stream(fingerprint, signal, pollMs);
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
            params: { fingerprint: id, ...(def.gateway.pollMs === undefined ? {} : { pollMs: def.gateway.pollMs }) },
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
        onRefetched: () => refetchWaiters.signal(id),
      });
    },
    status: () => connection,
    invalidate(prefix: SyncKey) {
      for (const { key, run } of invalidators.values()) {
        if (syncKeyMatches(key, prefix)) run();
      }
    },
    commit<TData>(request: SyncSourceWriteRequest<unknown>): Promise<TData> {
      return transport.rpc(request.method, request.vars) as Promise<TData>;
    },
    async confirm(prefix: SyncKey): Promise<void> {
      const ids: string[] = [];
      for (const [id, { key }] of invalidators) {
        if (syncKeyMatches(key, prefix)) ids.push(id);
      }
      if (ids.length === 0) return;
      await Promise.all(
        ids.map((id) => {
          // Register the waiter BEFORE pulsing so the refetch the pulse triggers
          // is the one that resolves it.
          const landed = refetchWaiters.wait(id, CONFIRM_REFETCH_TIMEOUT_MS);
          pulser.pulse(id);
          return landed;
        }),
      );
    },
    reset() {
      invalidators.clear();
      connection.reset();
    },
  };
}
