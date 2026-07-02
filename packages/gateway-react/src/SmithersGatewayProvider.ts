import { createElement, useMemo, type ReactNode } from "react";
import {
  SmithersGatewayClient,
  createSmithersDataClient,
  type SmithersGatewayClientOptions,
  type WorkspaceMode,
} from "@smithers-orchestrator/gateway-client";
import { SmithersGatewayContext } from "./SmithersGatewayContext.ts";
import { SmithersCollectionsProvider } from "./SmithersCollectionsProvider.ts";

export function SmithersGatewayProvider(props: {
  client?: SmithersGatewayClient;
  options?: SmithersGatewayClientOptions;
  mode?: WorkspaceMode;
  children?: ReactNode;
}) {
  const provided = props.client;
  const options = props.options;
  const client = useMemo(
    () => provided ?? new SmithersGatewayClient(options),
    // Memoize on primitive identity so an inline `options` object literal does
    // not re-create the client (and trigger a reconnect storm) every render.
    [provided, options?.baseUrl, options?.token],
  );
  const clientConfig = client as SmithersGatewayClient & { baseUrl?: string; token?: string };
  const apiBaseUrl = clientConfig.baseUrl ?? options?.baseUrl ?? "http://127.0.0.1:7331";
  const mode = props.mode ?? { kind: "local" as const, apiBaseUrl, ...(clientConfig.token ? { token: clientConfig.token } : {}) };
  const dataClient = useMemo(
    () => createSmithersDataClient({ mode, fetch: client.fetchImpl }),
    [client, mode.kind, mode.apiBaseUrl, "electricBaseUrl" in mode ? mode.electricBaseUrl : undefined, "workspaceId" in mode ? mode.workspaceId : undefined, mode.token],
  );
  return createElement(
    SmithersGatewayContext.Provider,
    { value: client },
    createElement(SmithersCollectionsProvider, { client: dataClient }, props.children),
  );
}
