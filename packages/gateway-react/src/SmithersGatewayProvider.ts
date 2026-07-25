import { createElement, useMemo, type ReactNode } from "react";
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
  const entries = Symbol.iterator in Object(headers)
    ? [...(headers as Iterable<readonly [string, string]>)]
    : Object.entries(headers as Record<string, string>);
  return entries.map(([name, value]) => `${name.toLowerCase()}:${value}`).sort().join("\n");
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
  const client = useMemo(
    () => provided ?? new SmithersGatewayClient(options),
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
  const clientConfig = client as SmithersGatewayClient & { baseUrl?: string; token?: string };
  const apiBaseUrl = clientConfig.baseUrl ?? options?.baseUrl ?? "http://127.0.0.1:7331";
  const mode = props.mode ?? { kind: "local" as const, apiBaseUrl, ...(clientConfig.token ? { token: clientConfig.token } : {}) };
  // The client's custom headers (API key, proxy auth) must reach the collection
  // API and change stream too, not just RPC. They ride along with the client
  // identity, so no extra memo dep is needed.
  const customHeaders = client.headers;
  const dataClient = useMemo(
    () => createSmithersDataClient({ mode, fetch: client.fetchImpl, ...(customHeaders ? { headers: customHeaders } : {}) }),
    [client, mode.kind, mode.apiBaseUrl, "electricBaseUrl" in mode ? mode.electricBaseUrl : undefined, "workspaceId" in mode ? mode.workspaceId : undefined, mode.token],
  );
  return createElement(
    SmithersGatewayContext.Provider,
    { value: client },
    createElement(SmithersCollectionsProvider, { client: dataClient }, props.children),
  );
}
