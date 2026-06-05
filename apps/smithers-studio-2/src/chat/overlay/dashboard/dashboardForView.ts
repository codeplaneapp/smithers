import type { ViewId } from "../../../useStudioStore";
import type { DashboardKey } from "./dashboards";

/**
 * Maps an openable Studio `ViewId` to its prototype `Dashboard`, or null when the
 * view has no seeded dashboard (e.g. DevTools, which opens the real surface). Lets
 * the Views menu open a populated overlay instead of a blank backend-less surface.
 */
export function dashboardForView(view: ViewId): DashboardKey | null {
  switch (view) {
    case "runs":
      return "runs";
    case "memory":
      return "memory";
    case "scores":
      return "scores";
    case "search":
      return "search";
    case "workflows":
      return "workflows";
    case "issues":
      return "issues";
    default:
      return null;
  }
}
