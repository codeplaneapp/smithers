import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { SmithersGatewayProvider, SyncProvider } from "@smithers-orchestrator/gateway-react";
import { bindRouteStore } from "./app/bindRouteStore";
import { router } from "./app/router";
import { bindDock } from "./apps/bindDock";
import { getGatewayClient } from "./gateway/gatewayClient";
import { RunsListBridge } from "./runs/RunsListBridge";
import { ApprovalsBridge } from "./approvals/ApprovalsBridge";
import { CronsBridge } from "./crons/CronsBridge";
import { MemoryFactsBridge } from "./memory/MemoryFactsBridge";
import { PromptsBridge } from "./prompts/PromptsBridge";
import { ScoresBridge } from "./scores/ScoresBridge";
import { TicketsBridge } from "./tickets/TicketsBridge";
import { startApprovalWatcher } from "./runs/watchApprovals";
import { appGatewayCollections } from "./sync/appGatewayCollections";
import "./styles.css";

// Wire the router into the route store and the dock before the first paint, so
// every store is live when the shell mounts.
bindRouteStore(router);
bindDock();
startApprovalWatcher();

/**
 * The gateway → Zustand bridges. Each subscribes a gateway-react live hook and
 * mirrors it into the matching Zustand store the surfaces read. Local-only: no
 * auth gate, no OPFS persistence, no Electric — the live RPC + WebSocket path
 * from the local gateway is the only source.
 */
function GatewayBridges() {
  return (
    <>
      <RunsListBridge />
      <ApprovalsBridge />
      <CronsBridge />
      <MemoryFactsBridge />
      <PromptsBridge />
      <ScoresBridge />
      <TicketsBridge />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SmithersGatewayProvider client={getGatewayClient()}>
      <SyncProvider client={appGatewayCollections}>
        <GatewayBridges />
        <RouterProvider router={router} />
      </SyncProvider>
    </SmithersGatewayProvider>
  </StrictMode>,
);
