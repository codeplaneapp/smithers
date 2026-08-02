import { useGatewayWorkflows } from "@smthrs/gateway-react";
import type { View } from "../app/routeStore";
import type { Surface } from "../app/Surface";
import { mapToStoreWorkflows } from "../store/workflowMetadata";
import type { StoreWorkflow } from "../store/workflows";
import type { App, AppId } from "./App";

/**
 * The static app catalog. Each entry promotes an existing domain surface (or the
 * store view) to a first-class app with a dock icon and a set of attachable
 * workflows. `workflowIds` is the app side of the app↔workflow many-to-many; the
 * ids match the default Smithers workflow pack registered on the gateway. The
 * APPS table + the `workflowIds` mapping are STATIC configuration (not data) and
 * stay local; the workflows they resolve to come from the live gateway registry.
 * See `.smithers/specs/apps-and-workflows-dock.md`.
 */
export const APPS: App[] = [
  {
    id: "runs",
    name: "Runs",
    icon: "▷",
    color: "#356fd2",
    target: { kind: "surface", surface: { kind: "runs" } },
    workflowIds: ["implement", "research-plan-implement", "mission"],
  },
  {
    id: "tickets",
    name: "Tickets",
    icon: "❏",
    color: "#a34d9f",
    target: { kind: "surface", surface: { kind: "tickets" } },
    workflowIds: ["ticket-create", "tickets-create", "kanban"],
  },
  {
    id: "approvals",
    name: "Approvals",
    icon: "✓",
    color: "#1f9d6b",
    target: { kind: "surface", surface: { kind: "approvals" } },
    workflowIds: ["review", "audit"],
  },
  {
    id: "agents",
    name: "Agents",
    icon: "◆",
    color: "#4a63d0",
    target: { kind: "surface", surface: { kind: "agents" } },
    workflowIds: ["grill-me", "mission"],
  },
  {
    id: "memory",
    name: "Memory",
    icon: "❋",
    color: "#6d56d8",
    target: { kind: "surface", surface: { kind: "memory" } },
    workflowIds: ["research", "workflow-skill"],
  },
  {
    id: "files",
    name: "Files",
    icon: "▤",
    color: "#7a6a2a",
    target: { kind: "surface", surface: { kind: "files" } },
    workflowIds: ["implement", "review"],
  },
  {
    id: "prompts",
    name: "Prompts",
    icon: "❝",
    color: "#2f7d9a",
    target: { kind: "surface", surface: { kind: "prompts" } },
    workflowIds: ["workflow-skill", "grill-me"],
  },
  {
    id: "scores",
    name: "Scores",
    icon: "▥",
    color: "#0f8f78",
    target: { kind: "surface", surface: { kind: "scores" } },
    workflowIds: ["improve-test-coverage", "audit"],
  },
  {
    id: "crons",
    name: "Crons",
    icon: "◷",
    color: "#c2691c",
    target: { kind: "surface", surface: { kind: "crons" } },
    workflowIds: ["ralph", "mission"],
  },
  {
    id: "vcs",
    name: "VCS",
    icon: "⌁",
    color: "#6f6a4f",
    target: { kind: "surface", surface: { kind: "vcs" } },
    workflowIds: ["implement", "review"],
  },
  {
    id: "store",
    name: "Store",
    icon: "▦",
    color: "#6d56d8",
    target: { kind: "view", view: "store" },
    workflowIds: [],
  },
];

const BY_ID = new Map(APPS.map((app) => [app.id, app]));

export function getApp(id: AppId): App | undefined {
  return BY_ID.get(id);
}

/**
 * Which app the current route is showing, or null when the route is not an app
 * (home, askme, a run surface, a utility surface). Surface apps match by kind;
 * the store app matches the `store` view.
 */
export function activeAppId(route: { view: View; surface: Surface | null }): AppId | null {
  if (route.surface) {
    const match = APPS.find((app) => app.target.kind === "surface" && app.target.surface.kind === route.surface!.kind);
    return match?.id ?? null;
  }
  const match = APPS.find((app) => app.target.kind === "view" && app.target.view === route.view);
  return match?.id ?? null;
}

/**
 * The workflows an app can launch (app side of the many-to-many), resolved
 * against a pre-fetched workflow catalog (the live `useGatewayWorkflows`
 * registry, mapped to `StoreWorkflow[]`). Pure: callers pass the catalog so this
 * stays React-free and testable.
 *
 * A `workflowId` that isn't present in `workflows` is dropped gracefully (no
 * crash) — on a small/probe gateway most of `APPS.workflowIds` won't resolve,
 * which is honest. Full app↔workflow parity is a real-dev-gateway concern (the
 * full default pack), not a probe-gateway one (see docs/p1a-plan.md risk #3).
 */
export function workflowsForApp(id: AppId, workflows: readonly StoreWorkflow[]): StoreWorkflow[] {
  const app = getApp(id);
  if (!app) return [];
  const byId = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  return app.workflowIds
    .map((workflowId) => byId.get(workflowId))
    .filter((workflow): workflow is StoreWorkflow => workflow !== undefined);
}

/**
 * React hook wrapper around {@link workflowsForApp}: resolves an app's attachable
 * workflows against the LIVE gateway registry. Use this from components; the bare
 * `workflowsForApp(id, workflows)` is the pure resolver for tests and callers
 * that already hold the catalog.
 */
export function useWorkflowsForApp(id: AppId): StoreWorkflow[] {
  const { data } = useGatewayWorkflows({ filter: { hasUi: true } });
  return workflowsForApp(id, mapToStoreWorkflows(data ?? []));
}

/** The apps a workflow is attached to (workflow side of the many-to-many). */
export function appsForWorkflow(workflowId: string): App[] {
  return APPS.filter((app) => app.workflowIds.includes(workflowId));
}
