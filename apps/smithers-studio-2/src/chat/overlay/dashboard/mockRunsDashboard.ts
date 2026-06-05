import type { Dashboard } from "./Dashboard";

/**
 * SEAM: the run board (`smithers ps`), seeded so `/runs` and the run toasts open
 * a populated surface without a backend. The real `runs/Runs` surface renders
 * empty in the chat prototype (no gateway). Mirrors the seeded toasts in
 * `toasts/mockToasts.ts` (triage / fix-flaky-tests / deploy-preview).
 */
export const mockRunsDashboard: Dashboard = {
  caption: "Active and recent runs across acme-web — smithers ps",
  sections: [
    {
      kind: "stats",
      heading: "Run board",
      tiles: [
        { label: "Running", value: "2", tone: "running" },
        { label: "Succeeded today", value: "9", tone: "success" },
        { label: "Failed today", value: "1", tone: "danger" },
        { label: "Awaiting approval", value: "1", tone: "warning" },
      ],
    },
    {
      kind: "table",
      heading: "Runs",
      columns: ["Run", "Workflow", "Step", "Duration", "State"],
      rows: [
        [
          { text: "run-8f2a1c", mono: true },
          { text: "triage" },
          { text: "draft fix PR" },
          { text: "2m 14s" },
          { text: "running", tone: "running" },
        ],
        [
          { text: "run-71be09", mono: true },
          { text: "deploy-preview" },
          { text: "typecheck" },
          { text: "0m 48s" },
          { text: "running", tone: "running" },
        ],
        [
          { text: "run-44c3d8", mono: true },
          { text: "land-pr" },
          { text: "approval gate" },
          { text: "—" },
          { text: "paused", tone: "warning" },
        ],
        [
          { text: "run-39a0f2", mono: true },
          { text: "fix-flaky-tests" },
          { text: "142/142 green" },
          { text: "4m 02s" },
          { text: "succeeded", tone: "success" },
        ],
        [
          { text: "run-2d77b4", mono: true },
          { text: "deploy-preview" },
          { text: "checkout.ts type error" },
          { text: "1m 09s" },
          { text: "failed", tone: "danger" },
        ],
      ],
    },
    {
      kind: "status-list",
      heading: "Needs you",
      rows: [
        {
          title: "land-pr · run-44c3d8",
          detail: "approve merge of PR #42 into main",
          status: "approval",
          tone: "warning",
        },
      ],
    },
  ],
};
