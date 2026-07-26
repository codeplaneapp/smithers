import type { View } from "../app/routeStore";
import type { Surface } from "../app/Surface";

/**
 * An app: a domain workspace you open and come back to, as opposed to a workflow
 * you launch and which finishes. Apps live in the right-edge dock while open.
 * See `.smithers/specs/apps-and-workflows-dock.md`.
 */
export type AppId =
  | "runs"
  | "tickets"
  | "approvals"
  | "agents"
  | "memory"
  | "files"
  | "prompts"
  | "scores"
  | "crons"
  | "vcs"
  | "store";

/** Where opening an app navigates: most apps open a canvas surface; a few are
 *  top-level views (the workflow store). */
export type AppTarget = { kind: "surface"; surface: Surface } | { kind: "view"; view: View };

export type App = {
  id: AppId;
  /** Tooltip + label shown in the dock. */
  name: string;
  /** Glyph drawn on the dock tile. */
  icon: string;
  /** Accent color for the tile. */
  color: string;
  target: AppTarget;
  /** Ids of the workflows this app can launch (the app side of the app↔workflow
   *  many-to-many; see `appsForWorkflow` for the inverse). */
  workflowIds: string[];
};
