import { createElement, useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  SmithersGatewayClient,
  createSmithersDataClient,
  type SmithersGatewayClientOptions,
  type WorkspaceMode,
} from "@smithers-orchestrator/gateway-client";
import { SmithersGatewayContext } from "./SmithersGatewayContext.ts";
import { SmithersCollectionsProvider } from "./SmithersCollectionsProvider.ts";

/**
 * Content identity for `options.headers`, covering all three `HeadersInit`
 * shapes. Name-lowercased and sorted so two literals that differ only in key
 * order hash the same and do not rotate the client.
 */
function headersIdentity(headers: HeadersInit | undefined) {
  if (!headers) {
    return "";
  }
  const entries =
    Symbol.iterator in Object(headers)
      ? [...(headers as Iterable<readonly [string, string]>)]
      : Object.entries(headers as Record<string, string>);
  return entries
    .map(([name, value]) => `${name.toLowerCase()}:${value}`)
    .sort()
    .join("\n");
}

/**
 * Closes a client the provider built once the provider stops using it — on
 * recreation and on unmount — and never touches one the caller passed in.
 *
 * The close is deferred by a microtask because React runs a cleanup and the
 * following setup in the same commit when it re-mounts a tree in place (what
 * StrictMode's double-invoke does): closing synchronously in the cleanup would
 * destroy the very client the next setup keeps using. Re-registering the same
 * instance cancels the pending close; a real drop has nothing to re-register,
 * so the close lands on the next microtask.
 */
function useOwnedClient(client: { close: () => void }, owned: boolean) {
  const pending = useRef<{ client: unknown; cancelled: boolean } | null>(null);
  useEffect(() => {
    if (pending.current?.client === client) {
      pending.current.cancelled = true;
      pending.current = null;
    }
    if (!owned) {
      return;
    }
    return () => {
      // Captured per registration, so the close can only ever hit the exact
      // instance this effect ran for — never a successor.
      const ticket = { client, cancelled: false };
      pending.current = ticket;
      queueMicrotask(() => {
        if (pending.current === ticket) {
          pending.current = null;
        }
        if (!ticket.cancelled) {
          client.close();
        }
      });
    };
  }, [client, owned]);
}

export function SmithersGatewayProvider(props: {
  client?: SmithersGatewayClient;
  options?: SmithersGatewayClientOptions;
  mode?: WorkspaceMode;
  children?: ReactNode;
}) {
  const provided = props.client;
  const options = props.options;
  const headerIdentity = headersIdentity(options?.headers);
  // Ownership rides with the instance: a client the provider constructed is
  // the provider's to close, a caller-supplied one never is.
  const rpc = useMemo(
    () => (provided ? { client: provided, owned: false } : { client: new SmithersGatewayClient(options), owned: true }),
    // Memoize on option *content* so an inline `options` object literal does
    // not re-create the client (and trigger a reconnect storm) every render —
    // while every behavior-affecting option still rotates it, so a new key,
    // transport, or client identity reaches the wire. `fetch`/`WebSocket` are
    // functions, whose reference is the only content they have.
    [
      provided,
      options?.baseUrl,
      options?.token,
      headerIdentity,
      options?.fetch,
      options?.WebSocket,
      options?.client?.id,
      options?.client?.version,
      options?.client?.platform,
    ],
  );
  const client = rpc.client;
  useOwnedClient(client, rpc.owned);
  const clientConfig = client as SmithersGatewayClient & { baseUrl?: string; token?: string };
  const apiBaseUrl = clientConfig.baseUrl ?? options?.baseUrl ?? "http://127.0.0.1:7331";
  const mode = props.mode ?? {
    kind: "local" as const,
    apiBaseUrl,
    ...(clientConfig.token ? { token: clientConfig.token } : {}),
  };
  // The client's custom headers (API key, proxy auth) must reach the collection
  // API and change stream too, not just RPC. They ride along with the client
  // identity, so no extra memo dep is needed.
  const customHeaders = client.headers;
  const dataClient = useMemo(
    () =>
      createSmithersDataClient({ mode, fetch: client.fetchImpl, ...(customHeaders ? { headers: customHeaders } : {}) }),
    [
      client,
      mode.kind,
      mode.apiBaseUrl,
      "electricBaseUrl" in mode ? mode.electricBaseUrl : undefined,
      "workspaceId" in mode ? mode.workspaceId : undefined,
      mode.token,
    ],
  );
  // There is no `dataClient` prop, so this one is always provider-owned — and
  // because it is passed down, `SmithersCollectionsProvider`'s own guard treats
  // it as caller-supplied and leaves it alone. Only here can it be closed.
  useOwnedClient(dataClient, true);
  return createElement(
    SmithersGatewayContext.Provider,
    { value: client },
    createElement(SmithersCollectionsProvider, { client: dataClient }, props.children),
  );
}
