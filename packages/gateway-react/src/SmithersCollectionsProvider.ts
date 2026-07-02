import { createElement, useEffect, useMemo, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createSmithersCollections,
  createSmithersDataClient,
  type SmithersDataClient,
  type WorkspaceMode,
} from "@smithers-orchestrator/gateway-client";
import { SmithersCollectionsContext } from "./SmithersCollectionsContext.ts";

function defaultMode(): WorkspaceMode {
  const baseUrl = typeof globalThis.location !== "undefined" ? globalThis.location.origin : "http://127.0.0.1:7331";
  return { kind: "local", apiBaseUrl: baseUrl };
}

export function SmithersCollectionsProvider(props: {
  mode?: WorkspaceMode;
  client?: SmithersDataClient;
  queryClient?: QueryClient;
  children?: ReactNode;
}) {
  const mode = props.mode ?? props.client?.mode ?? defaultMode();
  const queryClient = useMemo(
    () => props.queryClient ?? new QueryClient(),
    [props.queryClient],
  );
  const client = useMemo(
    () => props.client ?? createSmithersDataClient({ mode }),
    [props.client, mode.kind, mode.apiBaseUrl, "electricBaseUrl" in mode ? mode.electricBaseUrl : undefined, "workspaceId" in mode ? mode.workspaceId : undefined, mode.token],
  );
  const collections = useMemo(
    () => createSmithersCollections(client, queryClient),
    [client, queryClient],
  );

  useEffect(() => () => {
    collections.close();
  }, [collections]);

  return createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(
      SmithersCollectionsContext.Provider,
      { value: { client, collections, queryClient } },
      props.children,
    ),
  );
}
