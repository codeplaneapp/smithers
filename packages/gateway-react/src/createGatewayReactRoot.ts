import { createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { SmithersGatewayClient, type SmithersGatewayClientOptions } from "@smithers-orchestrator/gateway-client";
import { SmithersGatewayProvider } from "./SmithersGatewayProvider.ts";

export function createGatewayReactRoot(
  element: ReactElement,
  options: SmithersGatewayClientOptions & { rootId?: string } = {},
) {
  const root = document.getElementById(options.rootId ?? "root");
  if (!root) {
    throw new Error(`Gateway React root element not found: ${options.rootId ?? "root"}`);
  }
  const client = new SmithersGatewayClient(options);
  createRoot(root).render(createElement(SmithersGatewayProvider, { client, children: element }));
  return client;
}
