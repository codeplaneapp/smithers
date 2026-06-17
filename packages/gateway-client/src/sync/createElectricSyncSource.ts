import type { CollectionConfig } from "@tanstack/db";
import type { Txid } from "@tanstack/electric-db-collection";
import type { CollectionDef } from "./CollectionDef.ts";
import type { SyncSource, SyncSourceWriteRequest } from "./SyncSource.ts";
import type { SyncKey } from "./SyncKey.ts";
import { syncKeyFingerprint, syncKeyMatches } from "./SyncKey.ts";
import type { SyncTransport } from "./SyncTransport.ts";
import { createConnectionObserver } from "./createConnectionObserver.ts";
import { createElectricCollection } from "./createElectricCollection.ts";
import { createGatewaySyncSource } from "./createGatewaySyncSource.ts";
import { gatewayKeys } from "./gatewayKeys.ts";

export type ElectricSyncSourceOptions = {
  shapeUrl: string;
  writeUrl: string;
  headers?: Record<string, string | (() => string | Promise<string>)>;
  fetchClient?: typeof fetch;
  fallbackTransport?: SyncTransport;
  txidTimeoutMs?: number;
  onAuthError?: (error: Error) => void;
  onCollectionError?: (id: string, error: Error) => void;
  onCollectionReady?: (id: string) => void;
};

type TxidWaiter = {
  txid: Txid;
  prefixes: readonly SyncKey[];
};

type AwaitTxId = (txid: Txid, timeout?: number) => Promise<boolean>;

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeMethod(method: string): string {
  if (method === "runs.create") return "launchRun";
  if (method === "runs.cancel") return "cancelRun";
  if (method === "approvals.decide") return "submitApproval";
  if (method === "signals.send") return "submitSignal";
  return method;
}

function prefixesForWrite(method: string, vars: unknown): SyncKey[] {
  const normalized = normalizeMethod(method);
  const input = asRecord(vars);
  if (normalized === "launchRun") {
    const options = asRecord(input.options);
    const runId = asString(options.runId) ?? asString(input.runId);
    return runId
      ? [["gateway:listRuns"], gatewayKeys.run(runId)]
      : [["gateway:listRuns"]];
  }
  if (normalized === "submitApproval") {
    const runId = asString(input.runId);
    return runId
      ? [["gateway:listApprovals"], ["gateway:listRuns"], gatewayKeys.run(runId)]
      : [["gateway:listApprovals"], ["gateway:listRuns"]];
  }
  if (normalized === "cancelRun" || normalized === "submitSignal") {
    const runId = asString(input.runId);
    return runId
      ? [["gateway:listRuns"], gatewayKeys.run(runId)]
      : [["gateway:listRuns"]];
  }
  return [];
}

function authError(error: Error): boolean {
  return /\b(401|403|Unauthorized|Forbidden|UNAUTHORIZED|FORBIDDEN)\b/.test(error.message);
}

async function resolveHeaders(headers: ElectricSyncSourceOptions["headers"]): Promise<Headers> {
  const out = new Headers();
  for (const [key, value] of Object.entries(headers ?? {})) {
    out.set(key, typeof value === "function" ? await value() : value);
  }
  return out;
}

export function createElectricSyncSource(options: ElectricSyncSourceOptions): SyncSource {
  const connection = createConnectionObserver();
  const fallback = options.fallbackTransport
    ? createGatewaySyncSource({
        transport: options.fallbackTransport,
        onAuthError: options.onAuthError,
        onCollectionError: options.onCollectionError,
        onCollectionReady: options.onCollectionReady,
      })
    : undefined;
  const awaiters = new Map<string, { key: SyncKey; awaitTxId: AwaitTxId }>();
  const pendingTxids: TxidWaiter[] = [];
  const fetchClient = options.fetchClient ?? fetch;

  async function commitWrite<TData>(request: SyncSourceWriteRequest<unknown>): Promise<TData> {
    connection.markConnecting();
    const headers = await resolveHeaders(options.headers);
    headers.set("content-type", "application/json");
    try {
      const response = await fetchClient(options.writeUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: request.method, params: request.vars }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(asString(asRecord(body).message) ?? `Electric write failed with HTTP ${response.status}`);
      }
      const txid = typeof asRecord(body).txid === "number"
        ? asRecord(body).txid as Txid
        : typeof asRecord(asRecord(body).payload).txid === "number"
          ? asRecord(asRecord(body).payload).txid as Txid
          : undefined;
      if (txid !== undefined) {
        pendingTxids.push({ txid, prefixes: prefixesForWrite(request.method, request.vars) });
      }
      connection.markOnline();
      return (asRecord(body).payload ?? body) as TData;
    } catch (cause) {
      const error = asError(cause);
      if (authError(error)) {
        connection.markUnauthorized();
        options.onAuthError?.(error);
      } else {
        connection.markOffline();
      }
      throw error;
    }
  }

  return {
    collection<TRow extends object, TKey extends string | number>(
      def: CollectionDef<TRow, TKey>,
    ): CollectionConfig<TRow, TKey> {
      if (!def.electric) {
        if (!fallback) {
          throw new Error(`Electric SyncSource cannot load ${syncKeyFingerprint(def.key)} without a fallback transport.`);
        }
        return fallback.collection(def);
      }
      const id = syncKeyFingerprint(def.key);
      const config = createElectricCollection<TRow, TKey>({
        key: def.key,
        def,
        proxyUrl: options.shapeUrl,
        getKey: def.getKey,
        headers: options.headers,
        fetchClient,
        txidTimeoutMs: options.txidTimeoutMs,
        onAwaitTxIdReady: (awaitTxId) => {
          awaiters.set(id, { key: def.key, awaitTxId });
        },
        write: async (write) => {
          const result = await commitWrite<{ txid?: Txid | null }>({
            method: "electric.collection.write",
            vars: write,
          });
          return { txid: result.txid ?? null };
        },
        onError: (error) => {
          connection.markOffline();
          options.onCollectionError?.(id, error);
        },
        onReady: () => {
          connection.markOnline();
          options.onCollectionReady?.(id);
        },
      });
      return config;
    },
    status: () => connection,
    commit: commitWrite,
    async confirm(prefix: SyncKey): Promise<void> {
      const relevant = pendingTxids.filter((entry) => entry.prefixes.some((candidate) => syncKeyMatches(candidate, prefix)));
      if (relevant.length === 0) return;
      const matchingAwaiters = Array.from(awaiters.values()).filter((entry) => syncKeyMatches(entry.key, prefix));
      if (matchingAwaiters.length === 0) return;
      await Promise.all(
        relevant.flatMap((entry) =>
          matchingAwaiters.map((awaiter) => awaiter.awaitTxId(entry.txid, options.txidTimeoutMs ?? 10_000)),
        ),
      );
      for (const entry of relevant) {
        const index = pendingTxids.indexOf(entry);
        if (index >= 0) pendingTxids.splice(index, 1);
      }
    },
    reset() {
      awaiters.clear();
      pendingTxids.length = 0;
      fallback?.reset?.();
      connection.reset();
    },
  };
}
