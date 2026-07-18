/** @jsxImportSource react */
/**
 * The Smithers Monitor — a live web UI over every run in the workspace.
 *
 * Served by the gateway at /monitor (mounted by `smithers gateway`, opened by
 * `smithers monitor`). Purely an observer: it launches nothing, everything on
 * screen is live gateway state. Domain logic lives in ./monitorModel.ts.
 */
import { createGatewayReactRoot } from "smithers-orchestrator/gateway-react";
import { App, monitorMode } from "./monitorApp.tsx";
import { monitorCss as splitMonitorCss } from "./monitorCss.ts";
import { StatusTag as SplitStatusTag } from "./monitorShared.tsx";
import { StatCard as SplitStatCard } from "./monitorOps.tsx";
import {
  RunProgressCell as SplitRunProgressCell,
  RunsRail as SplitRunsRail,
  RunsTable as SplitRunsTable,
} from "./monitorRuns.tsx";

// Bun can emit invalid aliases for bare re-exports when the same modules are
// already in App's graph. Concrete entry bindings keep client.js executable.
export const monitorCss = splitMonitorCss;
export const RunProgressCell = SplitRunProgressCell;
export const RunsRail = SplitRunsRail;
export const RunsTable = SplitRunsTable;
export const StatCard = SplitStatCard;
export const StatusTag = SplitStatusTag;

if (typeof document !== "undefined") {
  if (monitorMode.theme) document.documentElement.dataset.theme = monitorMode.theme;
  const root = document.getElementById("root");
  if (root) createGatewayReactRoot(<App />);
}
