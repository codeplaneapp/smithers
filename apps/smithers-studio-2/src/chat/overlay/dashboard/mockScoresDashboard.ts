import type { Dashboard } from "./Dashboard";

/**
 * SEAM: scorer results (Views "Scores"), seeded so the surface renders populated
 * without a backend. The real `scores/Scores` surface reads live scorer output
 * from a run that is absent in the chat prototype.
 */
export const mockScoresDashboard: Dashboard = {
  caption: "Scorer results for the latest triage run — run-8f2a1c",
  sections: [
    {
      kind: "stats",
      heading: "Scores",
      tiles: [
        { label: "Overall", value: "0.92", tone: "success" },
        { label: "Scorers", value: "4", tone: "neutral" },
        { label: "Passing", value: "3 / 4", tone: "warning" },
      ],
    },
    {
      kind: "table",
      heading: "By scorer",
      columns: ["Scorer", "Score", "Threshold", "Result"],
      rows: [
        [{ text: "root-cause-found" }, { text: "1.00", mono: true }, { text: "≥ 0.80", mono: true }, { text: "pass", tone: "success" }],
        [{ text: "repro-coverage" }, { text: "1.00", mono: true }, { text: "≥ 0.75", mono: true }, { text: "pass", tone: "success" }],
        [{ text: "fix-quality" }, { text: "0.88", mono: true }, { text: "≥ 0.70", mono: true }, { text: "pass", tone: "success" }],
        [{ text: "diff-minimality" }, { text: "0.66", mono: true, tone: "warning" }, { text: "≥ 0.70", mono: true }, { text: "below", tone: "warning" }],
      ],
    },
  ],
};
