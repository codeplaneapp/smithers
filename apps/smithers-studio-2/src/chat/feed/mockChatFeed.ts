import type { ChatItem } from "./ChatItem";

/**
 * SEAM: a seeded conversation that exercises every feed capability — tags, the
 * agent HTML tool, and overlay openings (PR view + Runs surface) — so the chat
 * shell renders fully without a backend. Replace with a mapper over
 * `workspace/useAgentChat` blocks (enriched with server-written tags) later.
 */
export const mockChatFeed: ChatItem[] = [
  {
    id: "seed-1",
    role: "user",
    projectId: "acme-web",
    timestampMs: 1_716_900_000_000,
    tags: [{ id: "auth", label: "auth", kind: "topic" }],
    body: { kind: "markdown", text: "The login page 500s on Safari. Can you take a look and fix it?" },
  },
  {
    id: "seed-2",
    role: "assistant",
    projectId: "acme-web",
    timestampMs: 1_716_900_020_000,
    tags: [
      { id: "auth", label: "auth", kind: "topic" },
      { id: "wf-triage", label: "triage", kind: "workflow" },
    ],
    body: {
      kind: "markdown",
      text: "On it. I reproduced the 500 — `crypto.randomUUID` isn't available in the Safari version your CI targets. I kicked off the **triage** workflow to confirm the root cause across browsers.",
    },
  },
  {
    id: "seed-3",
    role: "assistant",
    projectId: "acme-web",
    timestampMs: 1_716_900_040_000,
    tags: [{ id: "wf-triage", label: "triage", kind: "workflow" }],
    body: {
      kind: "html",
      html: `<div style="font-family:system-ui;color:#e8eaf0">
        <strong>Browser repro matrix</strong>
        <table style="width:100%;border-collapse:collapse;margin-top:8px;font-size:13px">
          <tr style="text-align:left;color:#8b93a7"><th>Browser</th><th>Status</th></tr>
          <tr><td>Chrome 124</td><td style="color:#34D399">pass</td></tr>
          <tr><td>Firefox 126</td><td style="color:#34D399">pass</td></tr>
          <tr><td>Safari 16.3</td><td style="color:#F87171">500</td></tr>
        </table>
      </div>`,
    },
  },
  {
    id: "seed-4",
    role: "assistant",
    projectId: "acme-web",
    timestampMs: 1_716_900_060_000,
    tags: [
      { id: "auth", label: "auth", kind: "topic" },
      { id: "pr-42", label: "#42", kind: "pr" },
    ],
    body: {
      kind: "overlay",
      summary: "Opened PR #42 — fix: polyfill randomUUID for Safari",
      overlay: {
        kind: "pr",
        title: "PR #42",
        pr: {
          number: 42,
          title: "fix: polyfill randomUUID for Safari",
          author: "smithers-agent",
          branch: "fix/safari-uuid",
          state: "open",
          additions: 38,
          deletions: 4,
          changedFiles: 3,
          checks: [
            { name: "typecheck", status: "pass" },
            { name: "unit", status: "pass" },
            { name: "e2e", status: "pending" },
          ],
        },
      },
    },
  },
  {
    id: "seed-5",
    role: "assistant",
    projectId: "acme-web",
    timestampMs: 1_716_900_080_000,
    tags: [{ id: "runs", label: "runs", kind: "topic" }],
    body: {
      kind: "overlay",
      summary: "Here's the live run board while CI finishes.",
      overlay: { kind: "dashboard", title: "Runs", dashboard: "runs" },
    },
  },
  {
    id: "seed-5b",
    role: "assistant",
    projectId: "acme-web",
    timestampMs: 1_716_900_090_000,
    tags: [
      { id: "wf-triage", label: "triage", kind: "workflow" },
      { id: "auth", label: "auth", kind: "topic" },
    ],
    body: {
      kind: "overlay",
      summary: "The triage workflow ships a live dashboard — open it to watch progress.",
      overlay: { kind: "dashboard", title: "Triage dashboard", dashboard: "triage" },
    },
  },
  {
    id: "seed-6",
    role: "user",
    projectId: "payments",
    timestampMs: 1_716_900_200_000,
    tags: [{ id: "billing", label: "billing", kind: "topic" }],
    body: { kind: "markdown", text: "What's the status of the refund webhook?" },
  },
];
