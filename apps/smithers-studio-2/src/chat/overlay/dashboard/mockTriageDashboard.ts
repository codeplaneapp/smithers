import type { Dashboard } from "./Dashboard";

/**
 * SEAM: the triage workflow's live dashboard, seeded so "open triage dashboard"
 * renders a populated surface without a backend. Mirrors the seeded Safari-500
 * conversation in `feed/mockChatFeed.ts` (same bug, same repro matrix) so the
 * demo is coherent. Replace with the real triage workflow UI once it streams.
 */
export const mockTriageDashboard: Dashboard = {
  caption: "Root-cause triage for the Safari login 500 — auth · run wf-triage-8f2",
  sections: [
    {
      kind: "stats",
      heading: "Overview",
      tiles: [
        { label: "Browsers checked", value: "4 / 4", tone: "success" },
        { label: "Failing", value: "1", detail: "Safari 16.3", tone: "danger" },
        { label: "Root cause", value: "found", detail: "crypto.randomUUID", tone: "success" },
        { label: "Elapsed", value: "2m 14s", tone: "neutral" },
      ],
    },
    {
      kind: "table",
      heading: "Browser repro matrix",
      columns: ["Browser", "Login page", "randomUUID", "Result"],
      rows: [
        [{ text: "Chrome 124" }, { text: "200" }, { text: "available", mono: true }, { text: "pass", tone: "success" }],
        [{ text: "Firefox 126" }, { text: "200" }, { text: "available", mono: true }, { text: "pass", tone: "success" }],
        [{ text: "Edge 124" }, { text: "200" }, { text: "available", mono: true }, { text: "pass", tone: "success" }],
        [
          { text: "Safari 16.3" },
          { text: "500", tone: "danger" },
          { text: "undefined", mono: true, tone: "danger" },
          { text: "fail", tone: "danger" },
        ],
      ],
    },
    {
      kind: "status-list",
      heading: "Workflow steps",
      rows: [
        { title: "Reproduce across browsers", detail: "spun 4 headless sessions", status: "done", tone: "success" },
        { title: "Isolate failing call", detail: "stack trace → session.ts:42", status: "done", tone: "success" },
        { title: "Confirm root cause", detail: "crypto.randomUUID missing on Safari < 15.4", status: "done", tone: "success" },
        { title: "Draft fix PR", detail: "polyfill randomUUID → PR #42", status: "running", tone: "running" },
        { title: "Re-run repro matrix", detail: "waiting on PR checks", status: "queued", tone: "neutral" },
      ],
    },
  ],
};
