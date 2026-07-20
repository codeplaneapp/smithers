# Smithers 0.29.0 launch thread

Ready-to-post X/Twitter thread for the Smithers 0.29.0 release. Numbers are
taken verbatim from the release stats (`git log v0.28.0..HEAD`): 216 commits,
719 files changed, 84,182 insertions, 7,561 deletions, 50 feature commits,
67 bug-fix commits, 22 test commits, 42 docs commits.

Five tweets. The shared UI component library, the XState mount-time lint, and
the long tail of smaller improvements were cut to keep the thread on the three
features worth a demo. They stay in the [changelog](https://smithers.sh/changelogs/0.29.0).

Two tweets need **real recorded media** that does not exist yet: a live XState
machine visualization driven by a realistic workflow (tweet 3) and a memory
recall/retain visualization (tweet 2). See the [media plan](#media-plan).

---

### 1. Tweet 1

**Media:** hero card (TODO)

> Smithers 0.29.0 is out. 216 commits, 719 files changed, 84,182 insertions.
>
> First-class agent memory, XState machines folded over durable rows, and Microsandbox microVMs.
>
> bunx smithers-orchestrator@latest init

Claim IDs: release-scale, memory, xstate, microsandbox
Characters: 210

---

### 2. Tweet 2

**Media:** live memory visualization — recall → task → retain (TODO, see media plan)

> Agents that remember, declaratively.
>
> Wrap any part of a workflow in \<Memory\>. Every task inside recalls relevant context before it runs, gets remember/recall tools while it runs, and retains a digest after.
>
> Durable across runs, in a Hindsight bank on your own Postgres.

Claim IDs: memory
Characters: 271

---

### 3. Tweet 3

**Media:** live XState machine visualization on a realistic workflow (TODO, see media plan)

> XState v5, without a second scheduler.
>
> useSmithersMachine folds a machine over the output, approval, timeout, and signal rows Smithers already persists. Resume, fork, and rewind reconstruct the machine from the same durable history as the rest of the run.

Claim IDs: xstate
Characters: 256

---

### 4. Tweet 4

**Media:** microVM architecture diagram (TODO)

> Microsandbox is a first-class sandbox provider now, and it is fully open source.
>
> Each run boots a local microVM with its own Linux kernel and passes the request over the host-to-guest filesystem channel. No daemon, no hosted service, no vendor account.

Claim IDs: microsandbox, microsandbox-oss
Characters: 253

---

### 5. Tweet 5

**Media:** release inventory card (TODO)

> The honest shape of this release: 67 of 216 commits are fixes, 22 are tests.
>
> An empty bind={[]} provenance binding now parks as missing instead of dispatching an unproven task. Cron fires are claimed by compare-and-set, so nothing double-fires.
>
> https://smithers.sh/changelogs/0.29.0

Claim IDs: release-scale, hardening, security-bind, security-cron
Characters: 270 (URL normalized to 23 for t.co)

---

## Cut from the thread

Present in the changelog, deliberately not tweeted:

- The shared UI component library (Markdown, DiffHunks, FileTree, StageStrip,
  WorkflowGraph, Terminal adapters).
- The XState mount-time lint and optional-peer packaging.
- `onError`, LLM-judge eval assertions, OTLP auth headers, capped tool
  response bodies, detached-log relocation, gateway UI-registry rescan.

---

## Media plan

### Tweet 3 — XState visualization (blocking, must be built)

There is no example workflow using `useSmithersMachine` in the repo and no
state-chart visualization anywhere in the UI packages. Both have to be built
before this tweet can ship:

1. A realistic example workflow under `examples/` that folds a machine over
   durable rows (revision loop with approval + external `REVISE` signal is the
   shape the docs already teach).
2. A live UI at `.smithers/ui/<key>.tsx` that draws the machine: states, the
   active state, transitions, and the durable rows that drove each transition.
   `WorkflowGraph` from `smithers-orchestrator/gateway-ui` is the closest
   existing primitive.
3. Record the run driving the machine through states, including a
   `bunx smithers-orchestrator signal <runId> REVISE` from the terminal so the
   external-event path is visible.

### Tweet 2 — Memory visualization (blocking, must be built)

`packages/components/src/components/Memory.js` exists but nothing renders memory
state. Needs a UI showing, per task: what was recalled before the task, the
remember/recall tool calls during it, and the digest retained after.

### Tweets 1, 4, 5 — designed cards (SVG authored)

The SVG sources are written, reusing the same palette and 1600×900 canvas as
the 0.28.0 cards. Note this palette is marketing-card convention only, copied
from `marketing/0.28.0/assets/`; it is not the product design token set
(`packages/ui/src/tokens.ts` uses `--brand, #6d56d8`).

**They are not yet rasterized.** `render-pngs.mjs` needs Playwright, which is
not installed anywhere in this repo (it is an unmet optional dependency of
`.smithers`). X does not accept SVG uploads, so before posting:

```sh
pnpm -C .smithers install playwright && npx playwright install chromium
node marketing/0.29.0/assets/render-pngs.mjs
```

| Tweet | Asset | Kind | Status |
|-------|-------|------|--------|
| 1 | `assets/tweet-01-hero.svg` | hero | authored, needs PNG |
| 2 | `assets/memory-live.gif` | screen recording | **demo not built yet** |
| 3 | `assets/xstate-live.gif` | screen recording | **demo in progress** |
| 4 | `assets/tweet-04-diagram.svg` | diagram | authored, needs PNG |
| 5 | `assets/tweet-05-changelog.svg` | changelog | authored, needs PNG |

The hero, microsandbox diagram, and release-shape cards are also copied into
`docs/images/0.29.0/` and embedded in the changelog page.

Recording traps are documented in
`.smithers/prompts/release-content/record-ui-media.mdx` (stale gateway bundles,
"workspace" name attribution, never embed unverified screenshots).
