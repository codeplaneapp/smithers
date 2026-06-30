import { createRouter } from "@tanstack/react-router";
import { runDiffRoute } from "../diff/runDiffRoute";
import { gatewayRunRoute } from "../gateway/gatewayRunRoute";
import { runInspectorRoute } from "../runs/runInspectorRoute";
import { runLogsRoute } from "../runs/runLogsRoute";
import { runsRoute } from "../runs/runsRoute";
import { approvalsRoute } from "../approvals/approvalsRoute";
import { agentsRoute } from "../agents/agentsRoute";
import { memoryRoute } from "../memory/memoryRoute";
import { promptsRoute } from "../prompts/promptsRoute";
import { scoresRoute } from "../scores/scoresRoute";
import { cronsRoute } from "../crons/cronsRoute";
import { workflowEditorRoute } from "../store/workflowEditorRoute";
import { paletteRoute } from "../palette/paletteRoute";
import { storeRoute } from "../store/storeRoute";
import { runTicketsRoute } from "../tickets/runTicketsRoute";
import { runTimelineRoute } from "../timeline/runTimelineRoute";
import { appHistory } from "./history";
import { homeRoute } from "./homeRoute";
import { NotFoundPage } from "./NotFoundPage";
import { rootRoute } from "./rootRoute";

const routeTree = rootRoute.addChildren([
  homeRoute,
  storeRoute,
  runInspectorRoute,
  runLogsRoute,
  runDiffRoute,
  runTimelineRoute,
  runTicketsRoute,
  runsRoute,
  approvalsRoute,
  agentsRoute,
  memoryRoute,
  promptsRoute,
  scoresRoute,
  cronsRoute,
  workflowEditorRoute,
  paletteRoute,
  gatewayRunRoute,
]);

/** The app's single router. Its history adapts to web vs Electrobun (see appHistory). */
export const router = createRouter({
  routeTree,
  history: appHistory,
  defaultNotFoundComponent: NotFoundPage,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
