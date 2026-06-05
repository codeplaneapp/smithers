import type { Dashboard } from "./Dashboard";
import { mockTriageDashboard } from "./mockTriageDashboard";
import { mockRunsDashboard } from "./mockRunsDashboard";
import { mockMemoryDashboard } from "./mockMemoryDashboard";
import { mockIssuesDashboard } from "./mockIssuesDashboard";
import { mockWorkflowsDashboard } from "./mockWorkflowsDashboard";
import { mockScoresDashboard } from "./mockScoresDashboard";
import { mockSearchDashboard } from "./mockSearchDashboard";

/**
 * The prototype dashboards a `dashboard` overlay can open, keyed like `surface`
 * ids so descriptors stay light (the data lives here, not inlined in the feed).
 * SEAM: each value is seeded mock data; later the real Studio surface renders in
 * place. One registry so every entry point (feed, toasts, slash, Views) resolves
 * the same populated surface.
 */
export type DashboardKey =
  | "triage"
  | "runs"
  | "memory"
  | "issues"
  | "workflows"
  | "scores"
  | "search";

export const dashboards: Record<DashboardKey, Dashboard> = {
  triage: mockTriageDashboard,
  runs: mockRunsDashboard,
  memory: mockMemoryDashboard,
  issues: mockIssuesDashboard,
  workflows: mockWorkflowsDashboard,
  scores: mockScoresDashboard,
  search: mockSearchDashboard,
};
