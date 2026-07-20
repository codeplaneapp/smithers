# Smithers 0.29.0 launch thread

Ready-to-post X/Twitter thread for the Smithers 0.29.0 release. Numbers are
taken verbatim from the release stats (`git log v0.28.0..HEAD`): 224 commits,
724 files changed, 84,600 insertions, 7,561 deletions, 50 feature commits,
67 bug-fix commits, 22 test commits, 42 docs commits.

Five tweets. The shared UI component library, the XState mount-time lint, and
the long tail of smaller improvements were cut to keep the thread on the three
features worth a demo. They stay in the [changelog](https://smithers.sh/changelogs/0.29.0).

Media is attached for tweets 1, 3, 4, and 5. Tweet 2 still needs a memory
recall/retain recording. See the [media plan](#media-plan).

---

### 1. Tweet 1

**Media:** [hero card → assets/tweet-01-hero.png](assets/tweet-01-hero.png)

> Smithers 0.29.0 is out. 224 commits, 724 files changed, 84,600 insertions.
>
> First-class agent memory, XState machines folded over durable rows, and Microsandbox microVMs.
>
> bunx smithers-orchestrator@latest init

Claim IDs: release-scale, memory, xstate, microsandbox
Characters: 210

---

### 2. Tweet 2

**Media:** [memory lifecycle → assets/memory-live.png](assets/memory-live.png) — pending the retain fix

> Agents that remember, declaratively.
>
> Wrap any part of a workflow in \<Memory\>. Every task inside recalls relevant context before it runs, gets remember/recall tools while it runs, and retains a digest after.
>
> Durable across runs, in a Hindsight bank on your own Postgres.

Claim IDs: memory
Characters: 271

---

### 3. Tweet 3

**Media:** [Stately inspector → assets/xstate-devtools.png](assets/xstate-devtools.png)

> XState v5, without a second scheduler.
>
> useSmithersMachine folds a machine over the output, approval, timeout, and signal rows Smithers already persists. Resume, fork, and rewind reconstruct the machine from the same durable history as the rest of the run.

Claim IDs: xstate
Characters: 256

---

### 4. Tweet 4

**Media:** [microVM diagram → assets/tweet-04-diagram.png](assets/tweet-04-diagram.png)

> Microsandbox is a first-class sandbox provider now, and it is fully open source.
>
> Each run boots a local microVM with its own Linux kernel and passes the request over the host-to-guest filesystem channel. No daemon, no hosted service, no vendor account.

Claim IDs: microsandbox, microsandbox-oss
Characters: 253

---

### 5. Tweet 5

**Media:** [release inventory → assets/tweet-05-changelog.png](assets/tweet-05-changelog.png)

> The honest shape of this release: 67 of 224 commits are fixes, 22 are tests.
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

### Tweet 3 — XState devtools (DONE)

`assets/xstate-devtools.png` is a real Stately inspector rendering of
`releaseTrainMachine`, captured with `drafting` active after a REVISE.

**Caption honestly.** Smithers never creates an actor — `packages/xstate/src`
only calls pure `transition()`, which is the whole point of the feature. The
Stately inspector attaches to an actor, so it cannot observe a Smithers fold
directly. This image was produced by replaying the same events the fold derives
into a **display-only actor** built purely for visualization. Wording like
"visualizing the folded events" is accurate; anything implying Smithers runs an
actor inverts the feature.

Reproduce (throwaway, nothing committed): bundle a `createActor` +
`createBrowserInspector` entry from inside `.smithers` so deps resolve, serve
it, and screenshot the `stately.ai/registry/inspect` tab with Playwright.

The workflow itself (`.smithers/workflows/xstate-release-train.tsx`) and its
custom statechart UI are committed and verified end-to-end: run
`bunx smithers-orchestrator up .smithers/workflows/xstate-release-train.tsx`,
approve the gate, then
`bunx smithers-orchestrator signal <runId> REVISE --data '{"feedback":"..."}'`
and the machine advances `research → approval → draft-r0 → revise-r0 → draft-r1`.

### Tweet 2 — Memory visualization (BLOCKED on a product defect)

The demo, UI and tests are committed and both runs finish clean, but every
RECALL/RETAIN lane is empty because **`<Memory>` is a silent no-op in this
authoring path** — not because Hindsight is missing.

`engine.js:6595` reads `workflow.memoryService`; the only place it is ever
attached is `openSmithersBackend.js:50`. `createSmithers()` attaches nothing, so
`engine.js:4700` skips recall and tools and `retainTaskMemory()` returns at its
`!service` guard. Two runs, six `retain="on-complete"` tasks, zero facts written
(`memory list` still shows only an unrelated 6-day-old canary fact).

Hindsight is NOT required for the demo: without `HINDSIGHT_URL` the documented
behavior is a local SQLite facts store with keyword recall. It also runs locally
(`HINDSIGHT_URL=http://127.0.0.1:8888`, Postgres 15+ with pgvector) if we ever
want semantic recall and primers.

Unblocking sequence:

1. Land the `createSmithers()` memory-service fix (in progress).
2. Run the demo twice with related tickets so run two recalls run one.
3. Capture run two, where the RECALL and RETAIN lanes carry real content.

Do not capture before step 1 — the image would show a memory feature recalling
nothing.

### Tweets 1, 4, 5 — designed cards (SVG authored)

The SVG sources are written, reusing the same palette and 1600×900 canvas as
the 0.28.0 cards. Note this palette is marketing-card convention only, copied
from `marketing/0.28.0/assets/`; it is not the product design token set
(`packages/ui/src/tokens.ts` uses `--brand, #6d56d8`).

Rendered at 3200×1800 with `node marketing/0.29.0/assets/render-pngs.mjs`
(Playwright resolves from `.smithers`; `npx playwright` fails in this repo on an
npm override conflict, use `.smithers/node_modules/.bin/playwright`).

| Tweet | Asset | Kind | Status |
|-------|-------|------|--------|
| 1 | `assets/tweet-01-hero.png` | hero | ready |
| 2 | `assets/memory-live.png` | memory lifecycle | **blocked on retain fix** |
| 3 | `assets/xstate-devtools.png` | Stately inspector | ready |
| 4 | `assets/tweet-04-diagram.png` | diagram | ready |
| 5 | `assets/tweet-05-changelog.png` | changelog | ready |

The hero, microsandbox diagram, and release-shape cards are also copied into
`docs/images/0.29.0/` and embedded in the changelog page.

Recording traps are documented in
`.smithers/prompts/release-content/record-ui-media.mdx` (stale gateway bundles,
"workspace" name attribution, never embed unverified screenshots).
