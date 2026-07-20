# Smithers 0.29.0 launch thread

Ready-to-post X/Twitter thread for the Smithers 0.29.0 release. Numbers are
taken verbatim from the release stats (`git log v0.28.0..HEAD`): 213 commits,
699 files changed, 82,711 insertions, 7,559 deletions, 48 feature commits,
67 bug-fix commits, 22 test commits, 42 docs commits.

Media is **not yet produced** for this release. Each tweet below carries a
media brief; see the [media plan](#media-plan) at the bottom.

---

### 1. Tweet 1

**Media:** hero card (TODO)

> Smithers 0.29.0 is out. 213 commits, 699 files changed, 82,711 insertions.
>
> First-class agent memory, XState as durable derived state, a shared UI component library, and Microsandbox microVMs.
>
> bunx smithers-orchestrator@latest init

Claim IDs: release-scale, memory, xstate, ui-library, microsandbox
Characters: 232

---

### 2. Tweet 2

**Media:** `<Memory>` code card (TODO)

> Agents that remember, declaratively.
>
> Wrap any part of a workflow in \<Memory\>. Every task inside recalls relevant context before it runs, gets remember/recall tools while it runs, and retains a digest after.
>
> Durable across runs, in a Hindsight bank on your own Postgres.

Claim IDs: memory
Characters: 271

---

### 3. Tweet 3

**Media:** `useSmithersMachine` code card (TODO)

> XState v5, without a second scheduler.
>
> useSmithersMachine folds a machine over the output, approval, timeout, and signal rows Smithers already persists. Resume, fork, and rewind reconstruct the machine from the same durable history as the rest of the run.

Claim IDs: xstate
Characters: 256

---

### 4. Tweet 4

**Media:** lint-rejection diagram (TODO)

> A mount-time lint rejects invoke, spawn, after, and custom actions, and catches constant task identities in re-enterable states before they can deadlock a run.
>
> The machine stays derived state. Smithers stays the scheduler.
>
> xstate is an optional peer dependency.

Claim IDs: xstate, xstate-lint
Characters: 263

---

### 5. Tweet 5

**Media:** component-catalog card, or a live recording of a custom UI (TODO)

> If you have built a custom workflow UI, you have rebuilt a terminal, a diff view, or a markdown renderer more than once.
>
> Now shipped: Markdown (XSS-safe by construction, never innerHTML), DiffHunks, FileTree, StageStrip, a ReactFlow WorkflowGraph, an xterm Terminal.

Claim IDs: ui-library
Characters: 267

---

### 6. Tweet 6

**Media:** microVM architecture diagram (TODO)

> Microsandbox is now a first-class sandbox provider.
>
> Each run boots a local microVM with its own kernel and passes the request over the host-to-guest filesystem channel. No daemon, no hosted sandbox service.
>
> The Freestyle example provider is retired in its favor.

Claim IDs: microsandbox, freestyle-removal
Characters: 264

---

### 7. Tweet 7

**Media:** release inventory card (TODO)

> The honest shape of this release: 67 of 213 commits are fixes, 22 are tests.
>
> Two are security-scoped. An empty bind={[]} provenance binding now parks as missing instead of dispatching an unproven task. Cron fires are claimed by compare-and-set, so nothing double-fires.

Claim IDs: release-scale, hardening, security-bind, security-cron
Characters: 270

---

### 8. Tweet 8

**Media:** upgrade terminal card (TODO)

> Also: an onError hook for external error reporters, LLM-judge eval assertions, OTLP auth headers, capped tool response bodies.
>
> Detached run logs moved to .smithers/logs with retention cleanup. One workspace had 711 immortal log files at 1.4 GB.
>
> https://smithers.sh/changelogs/0.29.0

Claim IDs: onerror, evals, otlp, response-caps, detached-logs
Characters: 270 (URL normalized to 23 for t.co)

---

## Media plan

No assets exist for 0.29.0 yet. Two paths:

1. **Reuse the 0.28.0 card pipeline.** Copy
   `marketing/0.28.0/assets/render-pngs.mjs` plus one SVG as a template, author
   the seven cards, and render at 3200×1800.
2. **Record real UI media** for tweets 2 and 5 following
   `.smithers/prompts/release-content/record-ui-media.mdx`. Recorded media
   outperforms designed cards, but note the recording traps in that prompt
   (stale gateway bundles, "workspace" name attribution, never embed
   unverified screenshots).

| Tweet | Suggested asset | Kind |
|-------|-----------------|------|
| 1 | `assets/tweet-01-hero.png` | hero |
| 2 | `assets/tweet-02-memory.png` | code card |
| 3 | `assets/tweet-03-xstate.png` | code card |
| 4 | `assets/tweet-04-diagram.png` | diagram |
| 5 | `assets/tweet-05-components.png` | catalog card |
| 6 | `assets/tweet-06-diagram.png` | diagram |
| 7 | `assets/tweet-07-changelog.png` | changelog |
| 8 | `assets/tweet-08-terminal.png` | terminal |
