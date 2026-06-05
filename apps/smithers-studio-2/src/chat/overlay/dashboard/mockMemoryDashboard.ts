import type { Dashboard } from "./Dashboard";

/**
 * SEAM: cross-run memory (`smithers memory`), seeded so `/memory` and the Views
 * "Memory" entry open a populated surface without a backend. The real
 * `memory/Memory` surface queries a live `/memory` endpoint that is absent in the
 * chat prototype.
 */
export const mockMemoryDashboard: Dashboard = {
  caption: "Facts the agent has learned across runs — smithers memory",
  sections: [
    {
      kind: "stats",
      heading: "Memory",
      tiles: [
        { label: "Facts", value: "37", tone: "accent" },
        { label: "Namespaces", value: "5", tone: "neutral" },
        { label: "Written this week", value: "8", tone: "success" },
      ],
    },
    {
      kind: "table",
      heading: "Recent facts",
      columns: ["Namespace", "Key", "Value", "Updated"],
      rows: [
        [
          { text: "browser", mono: true },
          { text: "safari.randomUUID", mono: true },
          { text: "unavailable < 15.4 — polyfill required" },
          { text: "2m ago" },
        ],
        [
          { text: "ci", mono: true },
          { text: "flaky.checkout", mono: true },
          { text: "retries 3x; race on cart store hydration" },
          { text: "1h ago" },
        ],
        [
          { text: "deploy", mono: true },
          { text: "preview.region", mono: true },
          { text: "us-east-1 is fastest for acme-web" },
          { text: "yesterday" },
        ],
        [
          { text: "auth", mono: true },
          { text: "session.ttl", mono: true },
          { text: "30m sliding; refresh on activity" },
          { text: "3 days ago" },
        ],
        [
          { text: "convention", mono: true },
          { text: "commit.style", mono: true },
          { text: "emoji + conventional-commits, atomic" },
          { text: "1 week ago" },
        ],
      ],
    },
  ],
};
