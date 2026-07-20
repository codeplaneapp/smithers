import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import {
  SmithersCollectionsProvider,
  SmithersGatewayProvider,
} from "@smithers-orchestrator/gateway-react";
import { WorkflowUiStyles } from "@smithers-orchestrator/gateway-ui";
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
import { useWorkspaceStore } from "./app/workspaceStore";
import "./styles.css";

// Wire the router into the route store and the dock before the first paint, so
// every store is live when the shell mounts.
bindRouteStore(router);
bindDock();
startApprovalWatcher();

/**
 * The gateway → Zustand bridges. Each subscribes a gateway-react live hook and
 * mirrors it into the matching Zustand store the surfaces read. Local-only: no
 * auth gate, no OPFS persistence, no Electric. The local gateway domain API plus
 * TanStack DB collections are the only source.
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

function LocalWorkspaceRuntime() {
  const initialize = useWorkspaceStore((state) => state.initialize);
  const ready = useWorkspaceStore((state) => state.status === "ready");

  useEffect(() => {
    void initialize();
  }, [initialize]);

  return (
    <SmithersGatewayProvider client={getGatewayClient()}>
      <SmithersCollectionsProvider>
        {ready ? <GatewayBridges /> : null}
        <RouterProvider router={router} />
      </SmithersCollectionsProvider>
    </SmithersGatewayProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WorkflowUiStyles mode="theme" />
    <LocalWorkspaceRuntime />
  </StrictMode>,
);
