import { createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import {
  SmithersGatewayClient,
  createSmithersGatewayTransport,
  type SmithersGatewayClientOptions,
} from "@smithers-orchestrator/gateway-client";
import { SmithersGatewayProvider } from "./SmithersGatewayProvider.ts";
import { SyncProvider } from "./sync/SyncProvider.ts";
import { createGatewayCollections } from "./sync/createGatewayCollections.ts";

export function createGatewayReactRoot(
  element: ReactElement,
  options: SmithersGatewayClientOptions & { rootId?: string } = {},
) {
  const root = document.getElementById(options.rootId ?? "root");
  if (!root) {
    throw new Error(`Gateway React root element not found: ${options.rootId ?? "root"}`);
  }
  const client = new SmithersGatewayClient(options);
  // Mount BOTH contexts: the legacy `SmithersGatewayContext` for the on-demand
  // hooks (actions / node output / extensions) and the `SyncProvider` registry
  // for the live collection hooks (runs / run / approvals / run tree / events).
  // A custom workflow UI gets the full hook surface from one call.
  const collections = createGatewayCollections({ client: createSmithersGatewayTransport(client) });
  createRoot(root).render(
    createElement(
      SmithersGatewayProvider,
      { client },
      createElement(SyncProvider, { client: collections, children: element }),
    ),
  );
  return client;
}
