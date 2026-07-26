import { createElement, useEffect, useMemo, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createSmithersCollections,
  createSmithersDataClient,
  type SmithersCollections,
  type SmithersDataClient,
  type WorkspaceMode,
} from "@smithers-orchestrator/gateway-client";
import { SmithersCollectionsContext } from "./SmithersCollectionsContext.ts";

function defaultMode(): WorkspaceMode {
  const baseUrl = typeof globalThis.location !== "undefined" ? globalThis.location.origin : "http://127.0.0.1:7331";
  return { kind: "local", apiBaseUrl: baseUrl };
}

function isPromise(value: SmithersCollections | Promise<SmithersCollections>): value is Promise<SmithersCollections> {
  return typeof (value as Promise<SmithersCollections>).then === "function";
}

export function SmithersCollectionsProvider(props: {
  mode?: WorkspaceMode;
  client?: SmithersDataClient;
  queryClient?: QueryClient;
  children?: ReactNode;
}) {
  const mode = props.mode ?? props.client?.mode ?? defaultMode();
  const queryClient = useMemo(() => props.queryClient ?? new QueryClient(), [props.queryClient]);
  const client = useMemo(
    () => props.client ?? createSmithersDataClient({ mode }),
    [
      props.client,
      mode.kind,
      mode.apiBaseUrl,
      "electricBaseUrl" in mode ? mode.electricBaseUrl : undefined,
      "workspaceId" in mode ? mode.workspaceId : undefined,
      mode.token,
    ],
  );
  const collections = useMemo(() => createSmithersCollections(client, queryClient), [client, queryClient]);
  const [resolvedCollections, setResolvedCollections] = useState<SmithersCollections | null>(() =>
    isPromise(collections) ? null : collections,
  );
  const [loadError, setLoadError] = useState<unknown>(null);

  useEffect(
    () => () => {
      if (!props.client) client.close();
    },
    [client, props.client],
  );

  useEffect(() => {
    setLoadError(null);
    if (!isPromise(collections)) {
      setResolvedCollections(collections);
      return () => {
        collections.close();
      };
    }
    let cancelled = false;
    let active: SmithersCollections | null = null;
    setResolvedCollections(null);
    void collections.then(
      (next) => {
        active = next;
        if (cancelled) {
          next.close();
          return;
        }
        setResolvedCollections(next);
      },
      (error) => {
        if (!cancelled) setLoadError(error);
      },
    );
    return () => {
      cancelled = true;
      active?.close();
    };
  }, [collections]);

  const activeCollections = isPromise(collections) ? resolvedCollections : collections;
  if (loadError) throw loadError;
  if (!activeCollections) return null;

  return createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(
      SmithersCollectionsContext.Provider,
      { value: { client, collections: activeCollections, queryClient } },
      props.children,
    ),
  );
}
