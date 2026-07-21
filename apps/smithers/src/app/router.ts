import { createRouter } from "@tanstack/react-router";
import { filesRoute } from "../files/filesRoute";
import {
  gatewayRunDiffRoute,
  gatewayRunLogsRoute,
  gatewayRunRoute,
  gatewayRunTicketsRoute,
  gatewayRunTimelineRoute,
} from "../gateway/gatewayRunRoute";
import {
  legacyRunDiffRoute,
  legacyRunLogsRoute,
  legacyRunRoute,
  legacyRunTicketsRoute,
  legacyRunTimelineRoute,
} from "../runs/legacyRunRoutes";
import { runsRoute } from "../runs/runsRoute";
import { approvalsRoute } from "../approvals/approvalsRoute";
import { agentsRoute } from "../agents/agentsRoute";
import { memoryRoute } from "../memory/memoryRoute";
import { promptsRoute } from "../prompts/promptsRoute";
import { scoresRoute } from "../scores/scoresRoute";
import { cronsRoute } from "../crons/cronsRoute";
import { vcsRoute } from "../vcs/vcsRoute";
import { galleryRoute } from "../gallery/galleryRoute";
import { workflowEditorRoute } from "../store/workflowEditorRoute";
import { paletteRoute } from "../palette/paletteRoute";
import { storeRoute } from "../store/storeRoute";
import { runTicketsRoute } from "../tickets/runTicketsRoute";
import { appHistory } from "./history";
import { homeRoute } from "./homeRoute";
import { NotFoundPage } from "./NotFoundPage";
import { rootRoute } from "./rootRoute";

const routeTree = rootRoute.addChildren([
  homeRoute,
  storeRoute,
  legacyRunRoute,
  legacyRunLogsRoute,
  legacyRunDiffRoute,
  legacyRunTimelineRoute,
  legacyRunTicketsRoute,
  runTicketsRoute,
  runsRoute,
  approvalsRoute,
  agentsRoute,
  memoryRoute,
  filesRoute,
  promptsRoute,
  scoresRoute,
  cronsRoute,
  vcsRoute,
  galleryRoute,
  workflowEditorRoute,
  paletteRoute,
  gatewayRunRoute,
  gatewayRunLogsRoute,
  gatewayRunDiffRoute,
  gatewayRunTimelineRoute,
  gatewayRunTicketsRoute,
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
