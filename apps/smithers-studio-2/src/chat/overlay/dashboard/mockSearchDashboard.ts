import type { Dashboard } from "./Dashboard";

/**
 * SEAM: search results (Views "Search"), seeded so the surface renders populated
 * without a backend. The real `search/Search` surface queries a live index that
 * is absent in the chat prototype.
 */
export const mockSearchDashboard: Dashboard = {
  caption: "Across runs, PRs, memory, and issues — search",
  sections: [
    {
      kind: "status-list",
      heading: "Results for “safari”",
      rows: [
        { title: "PR #42 · fix: polyfill randomUUID for Safari", detail: "open · fix/safari-uuid", status: "pr", tone: "accent" },
        { title: "Issue #318 · Login page 500s on Safari", detail: "in progress · acme-web", status: "issue", tone: "running" },
        { title: "Memory · browser/safari.randomUUID", detail: "unavailable < 15.4 — polyfill required", status: "memory", tone: "neutral" },
        { title: "Run run-8f2a1c · triage", detail: "Safari 500 root-cause triage", status: "run", tone: "running" },
        { title: "Chat · seed-3", detail: "Browser repro matrix (Safari 16.3 → 500)", status: "chat", tone: "neutral" },
      ],
    },
  ],
};
