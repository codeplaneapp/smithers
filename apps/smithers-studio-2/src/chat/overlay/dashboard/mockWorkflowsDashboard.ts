import type { Dashboard } from "./Dashboard";

/**
 * SEAM: launchable workflows + run history (`/workflow`, Views "History"), seeded
 * so the surface renders populated without a backend. The real `workflows/
 * Workflows` surface lists workflows discovered by a live gateway that is absent
 * in the chat prototype.
 */
export const mockWorkflowsDashboard: Dashboard = {
  caption: "Launchable workflows and recent runs — smithers up",
  sections: [
    {
      kind: "table",
      heading: "Local workflows",
      columns: ["Workflow", "Summary", "Last run"],
      rows: [
        [{ text: "triage", mono: true }, { text: "Root-cause a bug across browsers" }, { text: "2m ago", tone: "running" }],
        [{ text: "fix-flaky-tests", mono: true }, { text: "Stabilize a failing test suite" }, { text: "18m ago", tone: "success" }],
        [{ text: "deploy-preview", mono: true }, { text: "Build and deploy a preview env" }, { text: "26m ago", tone: "danger" }],
        [{ text: "land-pr", mono: true }, { text: "Approve, merge, and verify a PR" }, { text: "1h ago", tone: "success" }],
      ],
    },
    {
      kind: "table",
      heading: "Recent history",
      columns: ["Run", "Workflow", "Finished", "Result"],
      rows: [
        [{ text: "run-39a0f2", mono: true }, { text: "fix-flaky-tests" }, { text: "18m ago" }, { text: "succeeded", tone: "success" }],
        [{ text: "run-2d77b4", mono: true }, { text: "deploy-preview" }, { text: "26m ago" }, { text: "failed", tone: "danger" }],
        [{ text: "run-1aa7e0", mono: true }, { text: "land-pr" }, { text: "1h ago" }, { text: "succeeded", tone: "success" }],
        [{ text: "run-0f3c92", mono: true }, { text: "triage" }, { text: "3h ago" }, { text: "succeeded", tone: "success" }],
      ],
    },
  ],
};
