# Implement: mirror a live smithers run into Claude Code's dynamic-workflow UI

## What you're building

A new smithers capability that makes a running smithers workflow **appear as a
native Claude Code "dynamic workflow"** in Claude Code's `/workflows` progress
tree. The real work still runs in the smithers engine (durability, worktrees,
retries, deps, db, time-travel all preserved). Claude Code's tree is a **live
mirror** of that run: one entry per smithers node, grouped into phases, updating
as the run progresses.

Concretely, ship:

1. A generator: `smithers graph <workflow> --emit-claude-workflow [--out <path>]`
   that writes a Claude Code workflow script to `.claude/workflows/<name>.mjs`.
2. The generated script itself: a frame-driven mirror that discovers smithers
   nodes and spawns one watcher `agent()` per node, grouped by `phase()`.
3. Docs + tests.

The end-to-end demo you must make work: a user (or agent) runs the generated
script via Claude Code's `Workflow` tool with `args: { runId }`, points it at a
detached smithers run, and watches the smithers DAG light up the `/workflows`
tree node-by-node until the run completes.

## Read this first — the hard constraints (do not relitigate them)

These were established by investigation. Build within them; don't try to beat
them.

1. **Claude Code's workflow progress UI can only be driven from inside the
   Claude Code session.** The `Workflow` tool runs a sandboxed JS script (no fs,
   no network, no Node API) whose `agent()` / `phase()` / `log()` calls are the
   *only* thing that populates the `/workflows` tree. There is no external IPC,
   socket, file, env-var, or hook that lets an outside process push entries in.
   So smithers cannot push into the UI. Instead, smithers **generates a script**
   that the in-session model runs, and that script **mirrors** smithers by
   reading smithers' own event/state surface.

2. **`agent()` always spawns a real subagent.** There is no "fake row"
   primitive. A mirror entry is therefore a real (tiny) watcher agent whose only
   job is to poll one smithers node to completion and return its output. Watchers
   must use the **smithers CLI over Bash** (always on PATH), not the smithers MCP
   server (which may be absent in headless/cron sessions).

3. **The Claude tree is append-only.** Once an `agent()` entry exists it cannot
   be retracted. Smithers can prune a node or flip it to `skipIf` after an output
   changes. The mapping: a vanished/skipped smithers node resolves its watcher as
   a completed **"skipped"** agent rather than disappearing. Accept this fidelity
   loss; document it.

4. **Hard caps in the Workflow runtime:** 1000 `agent()` calls per workflow
   lifetime, 4096 items per single `parallel()`/`pipeline()` call. A long looping
   smithers run can mint thousands of nodes. Design around this (see Task 4).

5. **Smithers workflows are dynamic.** The JSX re-renders a **frame** whenever
   outputs change, so the materialized task list differs frame to frame (tasks
   from `outputs.map(...)`, conditionals like `cond ? <Task/> : null`, loop
   iterations). A static snapshot is only correct for workflows with no
   data-dependent structure. The mirror MUST re-discover the node set as frames
   commit. Smithers already emits a `FrameCommitted` event — use it as the
   "DAG may have changed" signal.

6. **Honest ceiling:** you can only mirror nodes smithers has materialized in the
   current frame. A task gated on a not-yet-produced output doesn't exist in
   smithers' graph yet, so the mirror can't show it early either. That's parity
   with smithers' own UI, not a regression. Don't try to predict future nodes.

## Reject these alternatives (already considered)

- **Transpiling** the smithers workflow into a Claude workflow that does the real
  work (each smithers agent task becomes a real Claude `agent()`): throws away
  the entire reason to use smithers (deps/needs context passing, output schemas,
  approvals, signals, memory, scorers, retries, worktrees don't map). Don't.
- **Pushing into the Claude UI from smithers**: impossible per constraint 1.

## Where the pieces live (this is the smithers monorepo)

- `smithers graph` command + arg/option defs: `apps/cli/src/index.js` (search for
  `"graph"` command). It calls `renderFrame(...)` and returns a `GraphSnapshot`.
- `GraphSnapshot` shape: `packages/graph/src/GraphSnapshot.ts`
  (`{ runId, frameNo, xml: XmlNode|null, tasks: TaskDescriptor[] }`).
- `TaskDescriptor` (per-node metadata: `nodeId`, `label`, `agent`, `dependsOn`,
  `needs`, `parallelGroupId`, `ralphId`, `skipIf`, `worktreeId`, ...):
  `packages/graph/src/types.ts`.
- Graph extraction (JSX → flat tasks, container nesting): `packages/graph/src/extract.js`.
- Live observation surface (use these from watchers/discovery):
  - `smithers inspect <runId> --json` — full run state incl. **pending** nodes,
    node states, loop iterations, outputs. This is the primary discovery source.
  - `smithers node <runId> <nodeId> --json` — single node detail/output.
  - `smithers events <runId> --json --watch` — NDJSON event follow; event types
    incl. `NodeStarted`, `NodeFinished`, `NodeFailed`, `NodeSkipped`,
    `FrameCommitted`, `RunFinished` (see `apps/cli/src/event-categories.js` and
    `apps/observability/src/SmithersEvent.ts`).
  - `smithers ps --json`, `smithers output` for round-trip checks.
- Example workflows to test against: `.smithers/workflows/*.tsx`. Use one with a
  **data-dependent fan-out** so you exercise the dynamic path, e.g.
  `.smithers/workflows/bulletproof-audit.tsx` (builds its task list from
  `workItems`). Also test a simple static one.

## The Claude Code `Workflow` tool contract (the script you generate)

The generated `.mjs` must:

- Begin with a **pure-literal** `export const meta = { name, description, phases }`.
  No variables/calls/spreads in `meta`. `phases` is `[{ title, detail? }, ...]`
  derived from the smithers workflow's container nesting (`Sequence` / `Parallel`
  / `Loop` groups). Bake them as literals at generation time.
- Then a script body using these in-scope hooks (do not import them):
  - `await agent(prompt, { label, phase, schema? })` — spawns a subagent; with a
    JSON-schema `schema` it returns a validated object, else its final text.
  - `await parallel(thunks)` — barrier; concurrent; failed thunks resolve `null`.
  - `await pipeline(items, stage1, stage2, ...)` — per-item staged, no barrier.
  - `phase(title)` — open/scope a progress group. A `phase()` with no matching
    `meta.phases` entry gets its own group, so runtime-discovered phases work.
  - `log(msg)` — narrator line.
  - `args` — the value passed to the tool (you'll read `args.runId`, optional
    `args.cwd`, `args.dbPath`).
- The script is sandboxed: **no fs/network/Node** in the script body. All smithers
  access happens *inside* `agent()` subagents via Bash + the smithers CLI.

## Implementation tasks

Work docs-first (update `docs/` before code — repo convention), atomic commits,
real backends only (no mocks).

### Task 1 — Docs first
Add a docs page describing the feature, the mirror model, the
append-only/skip semantics, the caps, and the exact command. Update
`docs/` source, then regenerate bundles with `pnpm docs:llms` (CI gates on
`check-docs` / `check-llms`). Every new `package.json` script (if any) needs a
`package-configuration.mdx` row; no em-dashes in docs (gate enforces).

### Task 2 — Phase derivation
In `packages/graph` (or a small new module it exports), add a pure function that
turns a `GraphSnapshot` into an ordered phase list + a per-node `{ nodeId,
label, phase, kind }` mapping. Derive phases from the `xml` container tree:
`Sequence`/`Parallel`/`Loop` (`smithers:sequence|parallel|ralph`) become phase
groups; tasks inherit their nearest container's phase. Loop bodies are one phase
(iteration nodes land in it). Cover this with unit tests over real
`GraphSnapshot` fixtures produced by `renderFrame` (no hand-mocked trees).

### Task 3 — Generator command
Add `--emit-claude-workflow` (and `--out <path>`, default
`.claude/workflows/<workflow-name>-mirror.mjs`) to the `graph` command in
`apps/cli/src/index.js`. It runs the existing graph render, derives phases
(Task 2), and writes the `.mjs`. The literal `meta.phases` come from the derived
phases. Emit a deterministic, readable script (the watcher template from Task 4).

### Task 4 — The mirror script template (the heart of it)
The generated body must handle BOTH the static and dynamic cases with one
frame-driven discovery loop:

1. Maintain a `Set` of already-mirrored `nodeId`s (in script memory).
2. Loop until the run is terminal:
   a. Spawn a **discovery** `agent()` that runs `smithers inspect ${args.runId}
      --json` via Bash and returns (use a `schema`) the current node set:
      `[{ nodeId, label, phase, status }]` plus a `runStatus`. Pending nodes
      included.
   b. For each node not yet mirrored: if its `phase` is new, call `phase(phase)`;
      then spawn a **watcher** `agent()` (tagged `{ label, phase }`) whose job is:
      "poll `smithers node ${runId} ${nodeId} --json` (or `smithers events
      ${runId} --node ${nodeId} --json --watch`) until this node reaches a
      terminal state (`NodeFinished` / `NodeFailed` / `NodeSkipped` / cancelled),
      then return its output text (or `[skipped]` / `[failed: ...]`)." Watchers do
      NOT redo work; they only observe.
   c. Block the loop's next discovery on the **next `FrameCommitted`** (or run
      terminal) rather than tight-polling, so discovery-agent count stays bounded.
      A discovery agent can `smithers events ${runId} --type run --json --watch`
      and return once it sees a new `FrameCommitted` or `RunFinished`.
3. Watchers spawned across frames accumulate; let them run concurrently
   (`parallel`) within a frame; the loop adds new ones each frame.

**Cap mitigations (constraint 4) — pick and implement:**
- Only spawn watchers for **agent-kind** nodes by default; skip compute/static
  (they finish instantly and add noise). Make this a generator flag
  (`--mirror-all-nodes` to include them).
- Provide a `--collapse-phases` mode: one watcher per phase that streams a
  running summary of its nodes via the agent's progress line, instead of one
  watcher per node. Use this for runs that would exceed ~800 nodes.
- `log()` a clear message if the run would exceed the 1000-agent cap and the
  mirror stops adding watchers (never silently truncate — see repo "no silent
  caps" norm).

### Task 5 — Skip/prune fidelity (constraint 3)
If discovery reports a previously-pending node as gone or `skipped` in a later
frame, the watcher must resolve as a completed `[skipped]` entry (it can't be
removed). Make sure watchers don't hang forever on a node that vanished: bound
them with a sane timeout and a "node no longer present in inspect" exit.

## Testing (no mocks — repo rule)

CI runs on a clean box with no agent CLIs and no browsers. Tests must seed a fake
agent and not depend on a real Claude Code session.

1. **Unit**: phase derivation (Task 2) over real `GraphSnapshot`s from several
   `.smithers/workflows/*.tsx`, including a dynamic fan-out and a `Loop`.
2. **Generator e2e**: run `smithers graph <wf> --emit-claude-workflow`, assert the
   emitted `.mjs` starts with a pure-literal `export const meta`, has the expected
   phase titles, and is syntactically valid JS (parse it). Assert deterministic
   output (same input → same bytes).
3. **Mirror-logic e2e WITHOUT Claude Code**: factor the watcher/discovery logic so
   its smithers-facing half (parse `inspect --json`, detect terminal state, detect
   new `FrameCommitted`, diff node sets) is a plain testable module. Drive it
   against a **real** seeded smithers run (start a tiny workflow with the fake
   agent, `--detach`, then feed the module real `inspect`/`events` output and
   assert it discovers the right node set across frames, including a fan-out that
   grows between frames). This is the load-bearing test: it proves the mirror
   tracks a changing todo list on a real run. Gate any Claude-Code-session piece
   as a separate, skipped-in-CI manual check.
4. Run the gate before pushing: `pnpm typecheck`, `pnpm test`, and
   `pnpm -C e2e test` for anything you add to `e2e/`. If you touched `docs/`,
   `pnpm docs:llms` and commit the regenerated bundles.

## Deliverables checklist

- [ ] Docs page + regenerated llms bundles (`check-docs`/`check-llms` green).
- [ ] Pure phase-derivation function in `packages/graph` + unit tests.
- [ ] `smithers graph --emit-claude-workflow [--out] [--mirror-all-nodes]
      [--collapse-phases]` writing a valid, deterministic `.mjs`.
- [ ] Watcher/discovery template: frame-driven, append-only-safe, cap-aware,
      CLI-over-Bash (no MCP dependency).
- [ ] Testable smithers-facing mirror module + real-run e2e proving it tracks a
      growing/changing node set across frames.
- [ ] `pnpm typecheck` + `pnpm test` + relevant `e2e` green.

## Conventions (repo)

- Work on `main` directly; atomic emoji + Conventional Commits; end agent commits
  with the `Co-Authored-By` trailer. Commit with explicit pathspecs (shared tree;
  never `git add -A`). This is a jj colocated repo — diagnose with `jj st`/`jj log`.
- Prose: no em-dashes, no "not X but Y", no hedging/padding (docs gate enforces
  em-dashes anyway).
- One export per file, filename matches export; `index.ts` is barrels only;
  colocate types/errors by domain.
- Build smithers itself at the source; don't leave a local workaround.

## Start by

1. `smithers graph .smithers/workflows/bulletproof-audit.tsx --json` and read the
   real `xml` + `tasks` output so your phase derivation matches reality.
2. Read `packages/graph/src/GraphSnapshot.ts`, `types.ts`, `extract.js`, and the
   `graph` command in `apps/cli/src/index.js`.
3. Read `apps/observability/src/SmithersEvent.ts` for the exact event union and
   confirm `FrameCommitted` / `Node*` payload shapes before writing watchers.

---

# APPENDIX A — Claude Code "dynamic workflows": complete reference

You (the implementing agent) will likely have NO prior knowledge of Claude Code's
`Workflow` tool. This appendix is the full spec you need. The `.mjs` you generate
in Task 3/4 is a script for THIS runtime. Treat every statement here as the
contract.

## What it is

Claude Code (Anthropic's CLI coding agent) has a feature where the in-session
model calls a built-in `Workflow` tool with a JavaScript **script** that
orchestrates many subagents deterministically. The run executes in the
background; the user watches live progress in a `/workflows` view that renders a
**tree**: phases (groups) containing agents, with per-agent status, token usage,
and elapsed time. When the workflow finishes, the model receives a
`task-notification`.

Key ownership fact (already covered above, restated because it's the crux):
**only the in-session model can invoke the `Workflow` tool**, and the script runs
**inside** the Claude Code process. No outside process can call it or write to the
`/workflows` tree. That's why smithers *generates* a script rather than driving
the UI directly.

## Script anatomy

A workflow script is a single `.mjs`/`.js` file. It MUST begin with a `meta`
export, then a script body:

```js
export const meta = {
  name: 'smithers-mirror',                 // required, identifier-ish
  description: 'Mirror a smithers run',     // required, one line; shown in the permission dialog
  whenToUse: 'When mirroring a smithers run into /workflows',  // optional
  phases: [                                 // optional; one entry per logical phase
    { title: 'Discover', detail: 'poll smithers inspect' },
    { title: 'Audit',    detail: 'one watcher per audit node' },
    { title: 'Report' },
  ],
  // model: 'sonnet',                        // optional default model note
}

// --- script body starts here (top-level await is allowed) ---
phase('Discover')
const found = await agent('…', { schema: NODE_SET_SCHEMA })
// …
```

### `meta` rules (STRICT)
- `meta` must be a **pure literal**. No variables, no function calls, no spreads,
  no template interpolation inside it. Your generator computes the phase titles
  and writes them as literal strings into the file.
- Required: `name`, `description`. Optional: `whenToUse`, `phases`, `model`.
- `phases[].title` strings are **matched exactly** against `phase(title)` calls in
  the body. Same title → same group box. A `phase()` call whose title has no
  matching `meta.phases` entry simply gets its own group at runtime (this is how
  runtime-discovered smithers phases still render).

### Body rules (the sandbox)
- Plain **JavaScript, not TypeScript**. No type annotations (`: string`), no
  interfaces, no generics — they fail to parse.
- Runs in an async context: use `await` directly at top level.
- Standard JS builtins are available (`JSON`, `Math`, `Array`, `Set`, `Map`,
  string/array methods, etc.) **EXCEPT** `Date.now()`, `Math.random()`, and
  argless `new Date()` — these THROW (they would break workflow resume). If you
  need an id/nonce, derive it from a loop index or from data, not randomness.
- **No filesystem, no network, no Node/Bun API, no `require`/`import`** in the
  body. The body only orchestrates. All real I/O (running `smithers …`) happens
  inside `agent()` subagents, which DO have tool access (Bash, Read, etc.).

## The in-scope hooks (do not import them — they're globals)

### `agent(prompt, opts?) → Promise<any>`
Spawns one subagent. It appears as a row in the `/workflows` tree.
- Without `schema`: resolves to the subagent's **final message text** (string).
- With `opts.schema` (a JSON Schema object): the subagent is forced to call a
  `StructuredOutput` tool; `agent()` returns the **validated object** (no parsing
  needed; the model retries on mismatch).
- Returns `null` if the user skips the agent mid-run or it dies after retries.
  So `.filter(Boolean)` before using arrays of results.
- The subagent is told its final text **IS the return value** (not a chat
  message), so prompt it to return raw data.
- `opts` fields:
  - `label` (string): the display label for the row. Use the smithers nodeId or
    its `label`.
  - `phase` (string): assign this agent to a progress group. **Use this explicitly
    inside loops/`parallel`/`pipeline`** so grouping doesn't race the global
    `phase()` state. Same `phase` string → same box.
  - `schema` (JSON Schema): structured return (above).
  - `model` ('sonnet'|'opus'|'haiku'|'fable'): override model. **Omit by default**
    (inherits session model). For cheap watchers, `'haiku'` is reasonable.
  - `effort` ('low'|'medium'|'high'|'xhigh'|'max'): reasoning effort. Watchers and
    discovery are mechanical → `'low'`.
  - `isolation: 'worktree'`: run in a fresh git worktree. EXPENSIVE; only for
    agents that mutate files in parallel. **Mirror watchers do NOT need this**
    (they only observe).
  - `agentType` (string): use a custom subagent type instead of the default.
    Not needed here.

### `parallel(thunks) → Promise<any[]>`
Runs an array of `() => Promise` thunks concurrently. **Barrier**: awaits all
before returning. A thunk that throws resolves to `null` in the result array (the
call never rejects) → `.filter(Boolean)`. Use when you genuinely need all results
together (e.g. all watchers spawned this frame).

### `pipeline(items, stage1, stage2, ...) → Promise<any[]>`
Runs each item through all stages independently, **no barrier between stages**
(item A can be in stage 3 while item B is in stage 1). Each stage callback gets
`(prevResult, originalItem, index)`. A stage that throws drops that item to `null`
and skips its later stages. This is the default for multi-stage per-item work.

### `phase(title) → void`
Starts/opens a phase group; subsequent `agent()` calls (without an explicit
`opts.phase`) group under it. Inside concurrent code, prefer `opts.phase` over
relying on this global.

### `log(message) → void`
Emits a narrator line above the progress tree (user-visible). Use for "discovered
N new nodes", "run reached terminal state", cap warnings.

### `args`
The value passed as the tool's `args` input, verbatim. You will read
`args.runId` (and optionally `args.cwd`, `args.dbPath`) here. Pass it as real
JSON when launching, not a stringified blob.

### `budget` (optional, for scaling)
`budget.total` (number|null), `budget.spent()`, `budget.remaining()`. Lets a
workflow scale work to a token target. Not required for the mirror, but you may
use `budget` to cap how many watchers you spawn.

### `workflow(nameOrRef, args?) → Promise<any>`
Runs another saved workflow inline. Not needed here.

## Concurrency, caps, limits (design around these)
- Concurrent `agent()` calls are capped at `min(16, cpuCores - 2)` per workflow;
  excess calls queue and run as slots free. You can still pass hundreds of items
  to `parallel`/`pipeline`; only ~10–16 run at once.
- **Lifetime cap: 1000 `agent()` calls per workflow.** A long looping smithers run
  can exceed this → implement the cap mitigations in Task 4 and `log()` when you
  stop adding watchers. Discovery agents count toward this too, which is why
  discovery is `FrameCommitted`-gated, not tight-polled.
- **Per-call cap: 4096 items** in one `parallel`/`pipeline`.

## MCP and tools inside agents
Workflow agents can reach session-connected MCP tools via a `ToolSearch`
mechanism (schemas load on demand). BUT interactively-authenticated MCP servers
may be **absent in headless/cron runs**. The smithers MCP server is one such
optional dependency. **Therefore the mirror watchers must use the smithers CLI
over Bash, not the smithers MCP server** — Bash + `smithers …` is always
available to a workflow agent. (This is why Task 4 specifies CLI-over-Bash.)

## Launching, scriptPath, resume
- Saved workflow scripts live in `.claude/workflows/` (project) or
  `~/.claude/workflows/` (global). The model can launch one by name with `args`.
  The generator writes there.
- A script can also be launched from a file path (`scriptPath`). Constraint: it
  must begin with the pure-literal `export const meta`. The runtime reads the file
  at launch; it does NOT re-read it mid-run. So a generator-produced file is fine,
  but the body cannot "watch" the file for changes — all dynamism comes from
  `agent()` re-discovery at runtime (your frame loop), not from re-reading disk.
- `resumeFromRunId` resumes a paused workflow within the session (caches unchanged
  `agent()` calls). Not something an external process can target. Ignore for v1.

## Why this maps cleanly to smithers (mental model)
| smithers concept            | Claude workflow mirror representation                 |
|-----------------------------|-------------------------------------------------------|
| `Sequence`/`Parallel`/`Loop` container | a `phase` (group box) in `meta.phases`     |
| a materialized node (frame) | one watcher `agent()` row, `label`=nodeId, `phase`=its container |
| node running → finished     | watcher polls `smithers node … --json` until terminal, returns output |
| node skipped/pruned         | watcher resolves as a `[skipped]` row (append-only; can't remove) |
| frame re-render (`FrameCommitted`) | discovery agent re-reads `inspect`, script fans out watchers for new nodes |
| loop iteration nodes        | new nodeIds appearing across frames → new watcher rows in the loop's phase |

---

# APPENDIX B — worked example of the generated mirror script

This is the SHAPE the generator should emit (illustrative; adapt names, derive
`meta.phases` from the real graph, and harden the prompts). It shows the
frame-driven discovery loop, append-only watchers, CLI-over-Bash, and caps. Note:
the smithers-facing parsing/terminal-detection logic that this script delegates to
agents must ALSO exist as a plain, unit-tested module per Task 3 testing.

```js
export const meta = {
  name: 'smithers-mirror',
  description: 'Live-mirror a detached smithers run into the workflows tree',
  // phases are GENERATED literals derived from the workflow graph's containers:
  phases: [
    { title: 'audit',  detail: 'per-item audit nodes' },
    { title: 'report', detail: 'final report node' },
  ],
}

// Schema the discovery agent must return (JSON Schema, validated by the runtime).
const NODE_SET = {
  type: 'object',
  required: ['runStatus', 'nodes'],
  properties: {
    runStatus: { type: 'string' }, // running | finished | failed | cancelled
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['nodeId', 'label', 'phase', 'status', 'kind'],
        properties: {
          nodeId: { type: 'string' },
          label:  { type: 'string' },
          phase:  { type: 'string' },
          status: { type: 'string' }, // pending|running|finished|failed|skipped
          kind:   { type: 'string' }, // agent|compute|static|human|approval|...
        },
      },
    },
  },
}

const runId = args.runId
const cwdFlag = args.cwd ? ` --cwd ${args.cwd}` : ''
const mirrored = new Set()
const knownPhases = new Set()
const AGENT_BUDGET = 950 // stay under the 1000 lifetime cap
let spawned = 0

const TERMINAL = new Set(['finished', 'failed', 'cancelled'])

while (true) {
  // 1) DISCOVERY — read the current frame's node set via the smithers CLI.
  const snap = await agent(
    `Run this once and return its parsed result as structured output:
       smithers inspect ${runId} --json${cwdFlag}
     Extract the run status and the list of currently-materialized nodes.
     For each node return { nodeId, label, phase, status, kind }.
     Derive "phase" from the node's enclosing container/group name; if none, use "main".`,
    { label: 'discover', phase: 'audit', schema: NODE_SET, effort: 'low', model: 'haiku' }
  )
  if (!snap) break

  // 2) FAN OUT watchers for newly-seen nodes (append-only; agent-kind by default).
  const fresh = snap.nodes.filter(
    (n) => !mirrored.has(n.nodeId) && (n.kind === 'agent' /* || mirrorAllNodes */)
  )
  if (fresh.length && spawned < AGENT_BUDGET) {
    await parallel(
      fresh.slice(0, AGENT_BUDGET - spawned).map((n) => () => {
        mirrored.add(n.nodeId)
        spawned++
        if (!knownPhases.has(n.phase)) { knownPhases.add(n.phase); phase(n.phase) }
        return agent(
          `Watch ONE smithers node until it reaches a terminal state, then return its result.
             Poll: smithers node ${runId} ${n.nodeId} --json${cwdFlag}
           Terminal states: finished | failed | skipped | cancelled.
           If the node disappears from "smithers inspect" output, treat it as [skipped].
           Do NOT do any of the node's own work — only observe and report.
           Return the node's final output text, or "[skipped]" / "[failed: <msg>]".`,
          { label: n.label || n.nodeId, phase: n.phase, effort: 'low' }
        )
      })
    )
  }
  if (spawned >= AGENT_BUDGET) {
    log(`Reached watcher cap (${AGENT_BUDGET}); not mirroring further nodes for run ${runId}.`)
  }

  // 3) STOP if the run is terminal; else wait for the NEXT frame, then re-discover.
  if (TERMINAL.has(snap.runStatus)) break
  const tick = await agent(
    `Block until the smithers run advances, then return one word.
       smithers events ${runId} --type run --json --watch${cwdFlag}
     Return "frame" as soon as you observe a new FrameCommitted event,
     or "done" if you observe RunFinished/RunFailed/RunCancelled.`,
    { label: 'await-frame', phase: 'audit', schema: {
        type: 'object', required: ['next'], properties: { next: { type: 'string' } } },
      effort: 'low', model: 'haiku' }
  )
  if (!tick || tick.next === 'done') break
}

log(`Mirror complete for run ${runId}: ${mirrored.size} nodes mirrored.`)
return { runId, mirrored: [...mirrored] }
```

Notes on the example:
- It uses NO `Date.now`/`Math.random`. Counters drive everything.
- Every concurrent `agent()` carries an explicit `opts.phase`.
- Watchers are observe-only and CLI-driven, so no MCP dependency and no double
  execution of smithers work.
- The `AGENT_BUDGET` guard + `log()` honors the 1000-agent cap and the repo's
  "no silent caps" rule.
- `--collapse-phases` mode (Task 4) replaces the per-node fan-out with one watcher
  per phase that loops `smithers inspect` and streams a summary; emit that variant
  when the node count would blow the cap.

# IMPLEMENTATION PLAN (by Codex)

## Investigation Findings

- `packages/graph/src/index.ts` in this prompt is wrong. The real barrel is
  `packages/graph/src/index.js`; `packages/graph/src/index.d.ts` is generated.
- `GraphSnapshot` exists twice: `packages/graph/src/GraphSnapshot.ts` exports
  `{ runId, frameNo, xml: XmlNode | null, tasks: TaskDescriptor[] }`, while
  `packages/graph/src/types.ts` also declares readonly graph types.
- `TaskDescriptor` lives in `packages/graph/src/types.ts` and
  `packages/graph/src/TaskDescriptor.ts`; it includes `nodeId`, `ordinal`,
  `iteration`, `ralphId`, `dependsOn`, `needs`, `parallelGroupId`,
  `parallelMaxConcurrency`, `agent`, `prompt`, `staticPayload`, `computeFn`,
  `label`, `skipIf`, `worktree*`, `approval*`, timer/wait metadata via `meta`,
  and retry/cache fields.
- `packages/graph/src/extract.js` walks host nodes in `extractGraph(root, opts)`.
  It recognizes container tags including `smithers:ralph`,
  `smithers:parallel`, `smithers:merge-queue`, `smithers:worktree`,
  `smithers:saga`, and `smithers:try-catch-finally`; `smithers:sequence` is
  preserved in XML but does not affect task descriptors today. Tasks are emitted
  for `smithers:task`, `smithers:subflow`, `smithers:sandbox`,
  `smithers:wait-for-event`, and `smithers:timer`.
- `apps/cli/src/index.js` defines `graphOptions` as a `z.object` with
  `runId`, `input`, `root`, and `compact`. The `graph` command renders with
  `renderFrame(workflow, ctx, { baseRootDir, workflowPath })`, strips functions
  and optionally prompt text, then returns `c.ok(snapshot)`.
- The dev CLI must be invoked as `bun apps/cli/src/index.js ...`; plain
  `node apps/cli/src/index.js` fails on Bun module URLs.
- `smithers graph --help` does not list `--json`. JSON output is available via
  global `--format json`; tests also show some commands accept hidden
  command-level `--json` through the CLI formatter. A new implementation should
  document `--format json` for `graph` unless it deliberately adds a command
  `json` option.
- `smithers graph .smithers/workflows/bulletproof-audit.tsx --json` failed in
  this checkout before producing a snapshot: first because `--json` is not a
  listed graph option, then with `--format json --compact` because the workflow
  load hit `database is locked`. Static examples such as
  `.smithers/workflows/demo.tsx`, `.smithers/workflows/e2e-probe.tsx`, and
  `.smithers/workflows/dynamic-demo.tsx` failed here with `GRAPH_FAILED:
  render frame: null is not an object (evaluating 'dispatcher.useContext')`.
  Do not assume prompt line references or sampled graph output are valid until
  this local graph-render failure is addressed or isolated in temp fixtures.
- `inspect --help` exposes `--watch` and `--interval`, plus global
  `--format json`. It does not list a command `--json`, but
  `apps/cli/tests/json-stdout-contract.test.js` asserts `inspect <run> --json`
  emits parseable JSON.
- `node --help` syntax is `smithers node <nodeId> --run-id <runId>`, not
  `smithers node <runId> <nodeId>`. It exposes `--iteration`, `--attempts`,
  `--tools`, `--watch`, and `--interval`; JSON is via global `--format json`
  or hidden accepted `--json` in tests.
- `events --help` syntax is `smithers events <runId> [--node <id>]
  [--type <category>] [--json] [--watch]`. `--type` is an event category, not
  a raw event name; use `--type frame`, `--type run`, or `--type node`.
  `events --json` emits NDJSON lines shaped as
  `{ runId, seq, timestampMs, type, payload }`.
- `apps/observability/src/SmithersEvent.ts` confirms payloads:
  `FrameCommitted` has `runId`, `frameNo`, `xmlHash`, optional
  `trigger: { reason, nodeId?, iteration? }`, and `timestampMs`;
  `NodeStarted` has `runId`, `nodeId`, `iteration`, `attempt`, `timestampMs`;
  `NodeFinished` has the same fields; `NodeFailed` adds `error`; `NodeSkipped`
  has `runId`, `nodeId`, `iteration`, `timestampMs`; `RunFinished` has
  `runId`, `timestampMs`, optional `failedChildren`, optional
  `failedChildKeys`.
- `apps/cli/src/event-categories.js` maps `FrameCommitted` to `frame`,
  `RunFinished`, `RunFailed`, `RunCancelled`, and `RunContinuedAsNew` to `run`,
  and `NodeStarted`, `NodeFinished`, `NodeFailed`, `NodeCancelled`,
  `NodeSkipped`, and related node events to `node`.
- `buildInspectSnapshot` in `apps/cli/src/index.js` returns `{ run, runState?,
  failedChildren?, failedChildKeys?, steps, approvals?, timers?, loops?,
  config? }`. `steps` is an array of `{ id, state, attempt, label }`.
- `aggregateNodeDetailEffect` in `apps/cli/src/node-detail.js` returns enriched
  node JSON with `run`, `node`, `attempts`, `attemptSummary`, `output`,
  `tokenUsage`, `scorers`, and `approval` fields. It resolves latest iteration
  when `--iteration` is omitted.
- Docs source lives under `docs/`; add pages to `docs/docs.json`. Generated
  bundles are `docs/llms*.txt`, `apps/cli/docs/llms*.txt`, and
  `skills/smithers/llms-full.txt`. `pnpm docs:llms` runs
  `bun scripts/generate-llms.ts && bun scripts/optimize-llms-full.ts`.
- No package scripts are needed for this feature. If a script is later added,
  update `docs/reference/package-configuration.mdx`.

## Phase 1: Docs First

1. Create `docs/examples/claude-workflow-mirror.mdx`.
   - Document `smithers graph <workflow> --emit-claude-workflow`.
   - Document default output `.claude/workflows/<workflow-name>-mirror.mjs`.
   - Document `--out <path>`, `--mirror-all-nodes`, and `--collapse-phases`.
   - State that the generated Claude workflow observes an existing detached
     Smithers run supplied as `args.runId`.
   - State the append-only behavior: missing or skipped Smithers nodes resolve
     as completed `[skipped]` watcher rows.
   - State the 1000-agent lifetime cap, 4096 single-call item cap, and cap
     behavior.
   - Use `--format json` in examples for graph/inspect/node JSON surfaces,
     because `graph --json` is not a listed option today.
2. Edit `docs/docs.json`.
   - Add `examples/claude-workflow-mirror` under the `Examples` group, near
     `examples/dynamic-plan` and workflow samples.
3. Regenerate docs after code exists with `pnpm docs:llms`.
   - This updates `docs/llms-core.txt`, `docs/llms-full.txt`, `docs/llms.txt`,
     `apps/cli/docs/llms-full.txt`, `apps/cli/docs/llms.txt`, and
     `skills/smithers/llms-full.txt` as applicable.

## Phase 2: Graph Phase Derivation

1. Create `packages/graph/src/ClaudeWorkflowPhase.ts`.
   - Export type `ClaudeWorkflowPhase = { title: string; detail?: string }`.
2. Create `packages/graph/src/ClaudeWorkflowNodePhase.ts`.
   - Export type
     `ClaudeWorkflowNodePhase = { nodeId: string; label: string; phase: string; kind: "agent" | "compute" | "static" | "wait" | "timer" | "approval" | "subflow" | "sandbox" | "unknown" }`.
3. Create `packages/graph/src/ClaudeWorkflowPhasePlan.ts`.
   - Export type
     `ClaudeWorkflowPhasePlan = { phases: readonly ClaudeWorkflowPhase[]; nodes: readonly ClaudeWorkflowNodePhase[] }`.
4. Create `packages/graph/src/deriveClaudeWorkflowPhases.js`.
   - Export function signature:
     `export function deriveClaudeWorkflowPhases(snapshot, options = {})`.
   - JSDoc params:
     `snapshot: import("./GraphSnapshot.ts").GraphSnapshot`,
     `options?: { collapsePhases?: boolean }`.
   - Return type: `import("./ClaudeWorkflowPhasePlan.ts").ClaudeWorkflowPhasePlan`.
   - Build a `Map<string, TaskDescriptor>` by `nodeId` from `snapshot.tasks`.
   - Walk `snapshot.xml` depth first. Ignore text nodes.
   - Treat `smithers:sequence`, `smithers:parallel`, and `smithers:ralph` as
     phase containers. The prompt says `Loop`, but the real XML tag is
     `smithers:ralph`.
   - For container titles, prefer props in this order: `label`, `name`, `id`.
     Fallbacks: `Sequence`, `Parallel`, `Loop`.
   - Deduplicate titles deterministically by appending ` 2`, ` 3`, etc when two
     containers resolve to the same title.
   - The current phase is the nearest container phase. `smithers:workflow`
     supplies a fallback phase titled from `props.name` or `Workflow`.
   - When a task-like element is visited, resolve its logical node id from
     `props.id`; for loop-scoped rendered ids, match by exact id first, then by
     prefix plus `@@` only if needed. Assign that task to the current phase.
   - Task-like tags are `smithers:task`, `smithers:subflow`,
     `smithers:sandbox`, `smithers:wait-for-event`, `smithers:timer`, and
     approval-like tags if present in XML.
   - Classify kind from `TaskDescriptor`: `agent` when `task.agent` is present,
     `compute` when `task.computeFn` is present, `static` when
     `staticPayload !== undefined`, `wait` when `task.waitAsync` or
     `task.meta?.__waitForEvent`, `timer` when `task.meta?.__timer`,
     `subflow` when `task.meta?.__subflow`, `sandbox` when
     `task.meta?.__sandbox`, `approval` when `task.needsApproval` or
     `approvalMode` indicates a gate.
   - Append any task not encountered in XML in `snapshot.tasks` ordinal order to
     the fallback phase.
5. Edit `packages/graph/src/index.js`.
   - Add `export * from "./deriveClaudeWorkflowPhases.js";`.
   - Keep it a barrel only.
6. Do not hand-edit `packages/graph/src/index.d.ts` long term.
   - It is generated by `pnpm -C packages/graph build`; commit the updated
     declaration if the repo expects built declarations checked in.

## Phase 3: Generator and Mirror Modules

1. Create `apps/cli/src/claude-workflow/ClaudeWorkflowGeneratorOptions.ts`.
   - Export type
     `ClaudeWorkflowGeneratorOptions = { workflowPath: string; outputPath: string; workflowName: string; phasePlan: import("@smithers-orchestrator/graph").ClaudeWorkflowPhasePlan; mirrorAllNodes: boolean; collapsePhases: boolean; commandName?: string }`.
2. Create `apps/cli/src/claude-workflow/emitClaudeWorkflowMirror.js`.
   - Export `emitClaudeWorkflowMirror(options)`.
   - Return a deterministic string. Use only sorted or input-order data, stable
     JSON stringify with two-space indentation, `\n` line endings, and no
     timestamps, random ids, absolute local paths, or environment-derived text.
   - Emit `export const meta = { name, description, phases }` as pure literals.
   - `meta.phases` is produced directly from `phasePlan.phases` literals.
   - The body uses only in-scope `agent`, `parallel`, `pipeline`, `phase`,
     `log`, and `args`; no imports, fs, network, or Node APIs.
3. Create `apps/cli/src/claude-workflow/resolveClaudeWorkflowOutputPath.js`.
   - Export `resolveClaudeWorkflowOutputPath(workflowPath, out)`.
   - Default to `.claude/workflows/<basename-without-ext>-mirror.mjs` relative
     to `process.cwd()`.
   - Create parent directories in the CLI command, not in this pure resolver.
4. Create `apps/cli/src/claude-workflow/mirrorState.js`.
   - Export plain unit-tested functions used both by the generated template text
     and by non-Claude tests:
     `parseInspectJson(value)`,
     `isTerminalRunStatus(status)`,
     `isTerminalNodeState(state)`,
     `nodesFromInspect(inspect, phasePlan, options)`,
     `diffMirrorNodes(previousNodeIds, currentNodes)`,
     `eventSignalsFrame(event, lastFrameNo)`.
   - `parseInspectJson` accepts the real `inspect --format json` object:
     `run.status` and `steps: [{ id, state, attempt, label }]`.
   - `eventSignalsFrame` accepts the real NDJSON object from `events --json`:
     top-level `type`, `seq`, `timestampMs`, and nested `payload`.
   - Terminal run statuses are `finished`, `continued`, `failed`, and
     `cancelled`.
   - Terminal node states include at least `finished`, `failed`, `cancelled`,
     and `skipped`.
5. Create `apps/cli/src/claude-workflow/claudeWorkflowTemplate.js`.
   - Export `claudeWorkflowTemplate(options)`.
   - This keeps the large deterministic script body out of
     `apps/cli/src/index.js`.
   - Include a generated in-script copy of the small mirror-state helpers, or
     emit equivalent helper functions from string constants. The generated
     script cannot import local modules.
6. Edit `apps/cli/src/index.js`.
   - Add imports from `node:fs` if not already available:
     `mkdirSync`, `writeFileSync`.
   - Add imports:
     `deriveClaudeWorkflowPhases` from `@smithers-orchestrator/graph`;
     `emitClaudeWorkflowMirror` and `resolveClaudeWorkflowOutputPath` from the
     new CLI modules.
   - Extend `graphOptions` in the existing style:
     `emitClaudeWorkflow: z.boolean().default(false).describe("Emit a Claude Code dynamic workflow mirror script")`,
     `out: z.string().optional().describe("Output path for --emit-claude-workflow")`,
     `mirrorAllNodes: z.boolean().default(false).describe("Mirror compute/static/wait nodes as well as agent nodes")`,
     `collapsePhases: z.boolean().default(false).describe("Emit one watcher per phase instead of one watcher per node")`.
   - Add aliases only if consistent with existing CLI norms. Do not reuse `-o`
     unless the CLI already reserves it nowhere relevant.
   - In the `graph` command, after `snap` is built and JSON-sanitized, branch
     when `c.options.emitClaudeWorkflow` is true:
     derive phases from the original snapshot, resolve output path, emit script,
     create the parent dir, write the file, and return
     `c.ok({ workflow, outputPath, phases: phasePlan.phases, nodes: phasePlan.nodes.length })`.
   - Keep the current graph snapshot behavior unchanged when the flag is absent.

## Phase 4: Generated Script Contract

1. Generated `meta`.
   - Must be the first statement.
   - Shape:
     `export const meta = { name: "<workflow-name>-mirror", description: "...", phases: [{ title: "..." }] };`
   - `phases` literals come from `deriveClaudeWorkflowPhases`.
2. Runtime args.
   - Require `args.runId`.
   - Optional `args.cwd` becomes `cd <cwd> && smithers ...` inside Bash prompts.
   - Optional `args.dbPath` is not currently a real CLI flag for `inspect`,
     `node`, or `events`; the minimal implementation should not emit it into
     commands until the CLI gains a supported `--db-path` or env contract.
     Record this as a CLI gap.
3. Discovery agent.
   - Use `agent(prompt, { label: "Discover Smithers nodes", phase: "Discovery", schema })`.
   - Prompt tells the subagent to run:
     `smithers inspect ${runId} --format json`.
   - Schema returns
     `{ runStatus: string, nodes: [{ nodeId, label, state, phase, kind }] }`.
   - The prompt includes baked phase/node mapping from the generated script so
     discovered `steps` can be assigned phases without importing code.
4. Frame wait agent.
   - Use `smithers events ${runId} --type frame --json --watch` to wait for a
     `FrameCommitted`.
   - Also check run terminal by either `smithers inspect <runId> --format json`
     after an event wait or by a separate `smithers events --type run --json
     --watch` fallback. `--type` cannot filter both frame and run today, so the
     implementation must either run two watchers or poll inspect at frame
     boundaries. Prefer one frame watcher plus inspect terminal check to avoid
     extra agent count.
5. Node watcher agent.
   - Use real syntax:
     `smithers node ${nodeId} --run-id ${runId} --format json`.
   - Poll until node detail or inspect state is terminal.
   - Return response text or validated output when present; return `[skipped]`
     for skipped or vanished nodes; return `[failed: ...]` for failed nodes.
   - Include a bounded timeout and a final inspect check to avoid hanging on a
     pruned node.
6. Loop behavior.
   - Maintain `mirroredNodeIds` and `knownPhases`.
   - On each discovery, filter nodes by `kind === "agent"` unless
     `--mirror-all-nodes` was used.
   - Spawn newly discovered watchers grouped by phase. Use `parallel(thunks)` for
     each frame's additions, but do not wait for all prior-frame watchers before
     the next discovery unless the Claude Workflow runtime requires it.
   - If a runtime-discovered phase was absent from `meta.phases`, call
     `phase(title)` before spawning watchers.
   - Stop adding watchers at a conservative budget such as 950 and `log()` the
     skipped count.
7. Collapse mode.
   - When `--collapse-phases` is set, emit one watcher agent per phase. Each
     phase watcher polls inspect and summarizes node state changes for that
     phase until the run is terminal. This preserves the cap for large dynamic
     runs.

## Phase 5: Tests

1. Add `packages/graph/tests/derive-claude-workflow-phases.test.js`.
   - Use existing `hostEl` style from `packages/graph/tests/extract.test.jsx`,
     call `extractGraph`, then wrap in a real `GraphSnapshot` object.
   - Assert sequence, parallel, and ralph containers produce ordered phases.
   - Assert tasks inherit the nearest container phase.
   - Assert loop body tasks land in one loop phase.
   - Assert agent/compute/static/timer/wait/subflow/sandbox kinds from real
     descriptors.
2. Add `apps/cli/tests/claude-workflow-generator.test.js`.
   - Use `createTempRepo`, `writeTestWorkflow`, and `runSmithers`.
   - Run
     `smithers graph workflow.tsx --emit-claude-workflow --out .claude/workflows/test.mjs`.
   - Assert the file exists, starts with `export const meta =`, and parses with
     `new Function` or Bun's parser-safe equivalent after removing/export
     handling as needed.
   - Run the command twice and assert identical bytes.
   - Assert the returned JSON from `--format json` includes output path and
     phase count.
3. Add `apps/cli/tests/claude-workflow-mirror-state.test.js`.
   - Unit-test `parseInspectJson`, `isTerminalRunStatus`,
     `isTerminalNodeState`, `nodesFromInspect`, `diffMirrorNodes`, and
     `eventSignalsFrame` against real shapes from `buildInspectSnapshot` and
     `buildEventNdjsonLine`.
   - Include node vanished and skipped cases.
4. Add `apps/cli/tests/claude-workflow-mirror-real-run.e2e.test.js`.
   - Use `createTempRepo`, `writeFakeClaudeBinary` or `writeFakeCodexBinary`,
     `prependPath`, and a temp workflow that uses a fake agent and a
     data-dependent fan-out across frames.
   - Start with
     `smithers up workflow.tsx --detach --run-id mirror-real --format json`.
   - Poll `smithers inspect mirror-real --format json` until running or
     terminal.
   - Feed real inspect/events output into `mirrorState.js` functions.
   - Assert the module discovers the initial node set, observes a later
     `FrameCommitted`, discovers added fan-out nodes, and detects terminal run
     state.
   - Do not require a Claude Code session in CI.
5. Update existing CLI help or docs coverage tests if they assert exact command
   option lists.
   - Likely files: `apps/cli/tests/cli-help.test.js`,
     `apps/cli/tests/docs-cli-overview-coverage.test.js`, and
     `apps/cli/tests/docs-public-surface-coverage.test.js`.

## Phase 6: CLI Gaps to Close or Work Around

- `graph --json` is not a listed option. Work around with global
  `--format json`; add docs and tests using `--format json`.
- `inspect`, `node`, and `events` do not expose `--cwd` or `--dbPath`.
  The generated script can `cd args.cwd` before invoking `smithers`. It cannot
  honor `args.dbPath` until a supported CLI option or env var is added.
- `events --type` filters categories, not event names. Use `--type frame`,
  `--type run`, or `--type node`.
- `node` argument order in the prompt is wrong. Use
  `smithers node <nodeId> --run-id <runId>`.
- Current seeded workflow graph rendering failed in this checkout with a React
  hook error or locked DB. Implement tests in isolated temp repos first, then
  separately diagnose seeded workflow graph failures if acceptance requires
  `.smithers/workflows/*.tsx` examples.

## Phase 7: Verification

Run focused checks while developing:

```sh
pnpm -C packages/graph test
pnpm -C packages/graph typecheck
pnpm -C apps/cli test -- claude-workflow
pnpm -C apps/cli typecheck
```

Run the full gate before pushing:

```sh
pnpm typecheck
pnpm docs:llms
pnpm test
pnpm -C e2e test
```

If no `e2e/` files are touched, `pnpm -C e2e test` is still the requested gate
for this feature because the plan includes a real-run mirror e2e.

## Phase 8: Atomic Commit Sequence

1. `📝 docs(cli): document Claude workflow mirror generation`
   - Docs page, docs nav, regenerated llms bundles.
2. `✨ feat(graph): derive Claude workflow phases from graph XML`
   - New graph phase types, derivation function, graph tests, barrel export,
     generated declarations if required.
3. `✨ feat(cli): emit Claude workflow mirror scripts from graph`
   - CLI generator modules, graph command flags, generator tests.
4. `✅ test(cli): cover Smithers mirror state discovery`
   - Mirror-state module and unit tests.
5. `✅ test(cli): exercise mirror discovery against real detached runs`
   - Fake-agent real-run e2e and any helper fixtures.

Each commit should include the agent trailer:

```text
Co-Authored-By: Codex <codex@openai.com>
```

---

# PLAN REVIEW AND IMPROVEMENTS (by Claude)

I independently verified the real code surfaces and confirm Codex's plan is correct
on the CLI flags (`--format json`, `node <nodeId> --run-id <runId>`, `events
--type frame|run|node`, `up --detach --run-id --format json` all verified) and on
the file conventions. The improvements below are LOAD BEARING. Implement the plan
AS AMENDED here.

## A. The runtime nodeId -> phase mapping is the crux (make it deterministic)

`packages/graph/src/extract.js:186` builds loop/fan-out scope suffixes as
`@@${ralphId}=${iteration},...` and appends them to the logical id
(`nodeId = logicalNodeId + scope`, extract.js:441+). So a runtime nodeId for a
loop iteration or fan-out instance looks like `auditItem@@loop=2`.

Therefore:
1. At GENERATION time, bake two pure-literal maps into the script from the derived
   plan: `const PHASE_MAP = { "<logicalId>": "<phaseTitle>", ... }` and
   `const KIND_MAP = { "<logicalId>": "<kind>", ... }`.
2. At RUNTIME, map ANY discovered nodeId to its phase/kind with a pure helper:
   `const logical = nodeId.split("@@")[0]; const phase = PHASE_MAP[logical] ?? "main";`
   This makes dynamically minted loop/fan-out nodes land in the correct phase with
   zero LLM guessing and zero `Date.now`/`Math.random`. Add a unit test for this
   split-and-lookup over real `auditItem@@loop=2`-style ids.
3. Implementer MUST verify against a real detached run whether `smithers inspect
   --format json` `steps[].id` carries the full `@@`-suffixed runtime id (expected)
   or a collapsed logical id. If collapsed, enumerate runtime nodes via
   `smithers events <runId> --type node --json` instead. Decide and document.

## B. Keep smithers-JSON parsing OUT of the sandboxed script; agents + the tested module own it

Codex Phase 3.5 risks TWO copies of the parse/terminal logic (one in `mirrorState.js`,
one embedded as a string in the template) that can DRIFT. Resolve it:

- The generated SCRIPT contains ONLY deterministic orchestration: `meta`, `PHASE_MAP`,
  `KIND_MAP`, a `Set` of mirrored ids, the budget counter, the `nodeId.split("@@")[0]`
  helper, and `agent()`/`parallel()`/`phase()`/`log()` calls. It does NOT parse
  smithers JSON itself.
- The DISCOVERY agent runs `smithers inspect ${runId} --format json` and returns a
  schema-validated `{ runStatus, nodes: [{ nodeId, label, state }] }`. It returns
  the raw node set ONLY; the script assigns `phase`/`kind` locally from the baked
  maps. This removes LLM nondeterminism from phase/kind assignment.
- `apps/cli/src/claude-workflow/mirrorState.js` is a standalone, unit-tested module
  encoding the SAME contract the agent prompts describe (parse inspect json, detect
  terminal run/node state, detect new `FrameCommitted`, diff node sets). It is the
  testable ORACLE proving the contract holds on REAL data; the script does not (and
  cannot) import it. So the heavy logic is tested in exactly one place, and the
  script delegates that work to schema-validated agents. Do NOT embed a second copy
  of the parsing logic in the template string.

## C. Terminal-status semantics

- Terminal run statuses: `finished | failed | cancelled`. Stop the loop on these.
- `continued` / `RunContinuedAsNew` is NOT terminal and spawns a new runId the mirror
  does not follow. Do not treat it as `finished`. `log()` a clear note that the run
  continued-as-new under a new id and the mirror stops here. Document this as a known
  limitation in the docs page.
- Terminal node states for watchers: `finished | failed | skipped | cancelled`, plus
  "no longer present in inspect" => resolve as `[skipped]`. Bound each watcher with a
  finite poll budget so a vanished node cannot hang the row forever.

## D. Frame-wait + outer-loop backstop

Keep "one `--type frame --json --watch` agent + an inspect terminal check" (Codex 4.4).
Add a counter-based backstop on the OUTER discovery loop (e.g. `MAX_FRAMES = 5000`,
incremented per iteration, no `Date.now`) so a wedged run cannot loop forever, and
`log()` if the backstop trips. Never silently truncate (repo "no silent caps" rule).

## E. Determinism acceptance (tighten the generator test)

Same `(workflow, flags)` -> byte-identical output. Emit `\n` newlines, 2-space indent,
no `Date.now`/`Math.random`, and NO absolute paths (do not embed the temp-repo path or
cwd; the only run-specific value is `args.runId`, read at runtime). The generator e2e
must assert: (1) starts with `export const meta =`, (2) parses as valid JS, (3) two
consecutive emits are byte-identical, (4) the emitted file contains NONE of the temp
repo's absolute path.

## F. Tests use temp-repo workflows, never `.smithers/workflows/*.tsx`

The `.smithers/workflows/*.tsx` examples FAIL to render in this checkout (React
"Invalid hook call" / "database is locked"), so do not depend on them in tests.
- Phase-derivation unit test: build `GraphSnapshot`s via `extractGraph` over `hostEl`
  trees (the `packages/graph/tests/extract.test.jsx` style), including a `smithers:ralph`
  loop and a `smithers:parallel` fan-out.
- Real-run e2e: seed a TEMP workflow (createTempRepo / writeTestWorkflow) with a FAKE
  agent and a data-dependent fan-out that GROWS across frames; `smithers up
  workflow.tsx --detach --run-id <id> --format json`; feed real `inspect`/`events`
  output into `mirrorState.js` and assert it discovers the initial set, sees a later
  `FrameCommitted`, discovers the added fan-out nodes, and detects terminal state.
  This is the load-bearing test. No Claude Code session required in CI.

## G. Minor / confirmed

- `mirrorState.js` with several exports is acceptable: one-export-per-file is an
  unenforced convention and `apps/cli/src/event-categories.js` already exports 4.
  Keep it cohesive; do not over-split.
- No new `package.json` scripts, so no `package-configuration.mdx` row needed.
- Docs page: no em-dashes; use `--format json` in every JSON example; document the
  append-only/skip semantics, the 1000-agent and 4096-item caps, the `@@`-suffix
  runtime phase mapping, and the continue-as-new limitation (C). Regenerate bundles
  with `pnpm docs:llms` and commit them.
- Run the full gate before finishing each commit boundary; the interactive Claude
  session smoke test (launching the emitted `.mjs` via the `Workflow` tool against a
  real detached run) is a MANUAL, skipped-in-CI check, done in tmux during review.
