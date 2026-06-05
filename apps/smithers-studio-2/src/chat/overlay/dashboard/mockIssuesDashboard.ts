import type { Dashboard } from "./Dashboard";

/**
 * SEAM: issue tracker view, seeded so `/issue` opens a populated surface without
 * a backend. The real `issues/IssuesPanel` surface talks to a live JJHub issues
 * API that is absent in the chat prototype.
 */
export const mockIssuesDashboard: Dashboard = {
  caption: "Open work for acme-web — issue tracker",
  sections: [
    {
      kind: "stats",
      heading: "Issues",
      tiles: [
        { label: "Open", value: "6", tone: "accent" },
        { label: "In progress", value: "2", tone: "running" },
        { label: "Closed this week", value: "11", tone: "success" },
      ],
    },
    {
      kind: "table",
      heading: "Open issues",
      columns: ["#", "Title", "Owner", "State"],
      rows: [
        [
          { text: "#318", mono: true },
          { text: "Login page 500s on Safari" },
          { text: "smithers-agent" },
          { text: "in progress", tone: "running" },
        ],
        [
          { text: "#314", mono: true },
          { text: "Flaky checkout test on CI" },
          { text: "smithers-agent" },
          { text: "in progress", tone: "running" },
        ],
        [{ text: "#309", mono: true }, { text: "Add rate limit to /refund webhook" }, { text: "unassigned" }, { text: "open" }],
        [{ text: "#301", mono: true }, { text: "Dark-mode contrast on stat tiles" }, { text: "unassigned" }, { text: "open" }],
        [{ text: "#298", mono: true }, { text: "Cache busting for preview deploys" }, { text: "unassigned" }, { text: "open" }],
      ],
    },
  ],
};
