# Claude plugin: default-on /workflows mirror (supersedes PR #462)

Status: proposed design, 2026-07-02. Replaces the approach in PR #462
(`feat/claude-workflow-mirror`, marked DO NOT MERGE). Author context: researched
against the live repo, the recovered PR working spec (PROMPT.md, commit
4a5bff07f0), and the official Claude Code plugin reference.

## 1. Goal and non-goals

Goal: a user installs the smithers Claude Code plugin. From then on, every
smithers run driven from Claude Code appears live in Claude Code's `/workflows`
progress tree: phases from the workflow's containers, one row per node, states
and outputs updating as the run progresses. Zero per-workflow steps, zero
generation, works for workflows that do not exist yet, works for data-dependent
fan-outs and loops. The real work stays in the smithers engine; `/workflows` is
a view.

Non-goals (settled in PR #462's working spec, still true):

- Transpiling smithers workflows into native Claude workflows that do the real
  work. That discards deps/needs, schemas, approvals, retries, worktrees.
- Pushing into the `/workflows` UI from an external process. The UI is only
  populated by an in-session Workflow-tool script calling
  `phase()`/`agent()`/`log()`. Confirmed still true in July 2026.
- Replacing the gateway-react browser UI (`smithers ui`). It remains the rich
  surface; the mirror is the always-on in-terminal surface.

## 2. Why PR #462 is the wrong shape

PR #462 works (the demo gif is real) but cannot be default-on:

1. **Per-workflow generation.** `smithers graph <wf> --emit-claude-workflow`
   must be run per workflow and re-run on every workflow edit. The plugin
   cannot do this for workflows it has never seen.
2. **Baked maps go stale.** PHASE_MAP/KIND_MAP are frozen at generation time;
   dynamic nodes fall into a fallback phase; a renamed container silently
   mislabels the tree.
3. **Token burn.** One haiku watcher per node polls `smithers node` up to 300
   times; a discovery agent AND a frame-wait agent run per frame. Every agent
   parses CLI JSON from prose instructions; the unit-tested oracle
   (`mirrorState.js`) is not what executes, prompts approximating it are.
4. **Slot starvation.** The Workflow runtime caps concurrent agents at
   min(16, cores-2). Long-polling watchers hold slots, so a 20-wide smithers
   fan-out queues the discovery loop behind its own watchers.
5. **Lifecycle holes.** No launch flow (assumes a pre-existing detached run),
   stops at continue-as-new, approvals invisible, no story for the plugin.

## 3. Facts the new design stands on (verified 2026-07-02)

Claude Code side (plugin reference + Workflow tool contract):

- Plugins ship: skills (with supporting files), commands, agents, hooks, MCP
  servers, LSP servers, and experimental background **monitors** (a shell
  command per session whose stdout lines are delivered to Claude as
  notifications; v2.1.105+, interactive sessions only). There is **no plugin
  `workflows/` component**; named workflows resolve from `.claude/workflows/`
  only.
- `${CLAUDE_PLUGIN_ROOT}` is substituted in hooks, MCP, LSP, and monitor
  configs. It **changes on every plugin update** (old dir lingers ~7 days).
  `${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/<id>/`) persists across
  updates.
- SessionStart hooks run at session begin/resume and their stdout is injected
  into Claude's context. This is the sanctioned "tell the model something at
  startup" channel.
- The Workflow tool accepts `scriptPath` pointing anywhere on disk; the file is
  read once at launch, so a mid-run plugin update cannot break an in-flight
  mirror.
- Runtime caps: min(16, cores-2) concurrent agents, 1000 lifetime, 4096 items
  per parallel/pipeline call, append-only tree, sandbox (no fs/network/Node,
  no Date.now/Math.random). Bash inside an agent caps at 10 minutes per call.

Smithers side (repo, main):

- The store already persists everything a mirror needs, per frame:
  `_smithers_frames.xml_json` (full container tree), `taskIndexJson`
  (`{nodeId, ordinal, iteration, kind}` where kind is the TaskDescriptor kind:
  agent/compute/static/human), `_smithers_nodes` (state, label per
  nodeId/iteration), `_smithers_attempts` (output text, errors),
  `_smithers_approvals`, `_smithers_human_requests`, and an event log with
  monotonic `seq` (`FrameCommitted{frameNo}`, `NodeStarted/Finished/Failed/
  Skipped`, `RunFinished/Failed/Cancelled/ContinuedAsNew`).
  **A mirror state for a live run is therefore computable server-side from the
  store alone, with no .tsx execution and no baked maps.**
- `deriveClaudeWorkflowPhases(snapshot)` from the PR branch (packages/graph) is
  sound and unit-tested; it only needs a variant that takes a persisted frame
  (`xml_json` + task index) instead of a live `renderFrame` snapshot.
- MCP tools already exist for control: `run_workflow` (background by default),
  `watch_run` (blocking poll), `list_pending_approvals`, `resolve_approval`,
  `ask_human`. The CLI has `inspect/node/events` with polling `--watch`.

## 4. Design overview

Three pieces, one contract:

1. **`smithers claude` CLI surface** (new, in apps/cli): purpose-built,
   versioned, machine-readable commands that do ALL derivation and ALL blocking
   in-process. Workflow agents become one-command pipes: run exactly one
   command, return its JSON.
2. **One generic mirror script**, `claude-plugin/workflows/smithers-run.mjs`,
   shipped inside the plugin. Workflow-agnostic: phases, kinds, labels, and
   deltas all come from `smithers claude tick` at runtime. It both launches
   runs and attaches to existing ones.
3. **Plugin wiring** that makes it default-on: a SessionStart hook announces
   the script's absolute path (from `${CLAUDE_PLUGIN_ROOT}`) plus usage in one
   context line; the rewritten skill makes "launch detached, then mirror" the
   standard flow; an optional monitor streams approval/failure notifications to
   the main loop.

The PR's insight (mirror via in-session script reading the CLI over Bash) is
kept. Everything brittle about it (generation, baked maps, prose parsing,
long-polling) moves server-side or disappears.

## 5. New CLI surface: `smithers claude ...`

System-facing protocol commands (hidden from default help listings, like
system workflows). All output `--format json` only. All go through the same
store resolution as `inspect`/`events` (`findAndOpenDb`), so backend support
tracks the pluggable-DB work.

### 5.1 `smithers claude tick <runId> [--after-seq N] [--wait] [--timeout-ms M] [--max-output-chars K]`

One call = one complete mirror frame plus deltas. Response (contract v1):

```json
{
  "contract": 1,
  "runId": "run-abc",
  "status": "running",
  "seq": 412,
  "frameNo": 7,
  "timedOut": false,
  "phases": [{ "title": "Plan" }, { "title": "Implement" }],
  "nodes": [
    { "nodeId": "plan", "label": "Plan the change", "phase": "Plan",
      "kind": "agent", "state": "finished", "iteration": 0, "attempt": 1 }
  ],
  "changed": ["plan"],
  "outputs": { "plan": "…truncated to K chars (default 2000)…" },
  "approvals": [
    { "nodeId": "gate", "iteration": 0, "title": "Deploy to prod?",
      "requestedAtMs": 1780000000000 }
  ],
  "humanRequests": [],
  "continuedAs": null
}
```

- `status`: the run row status (`running`, `waiting-approval`, `waiting-event`,
  `waiting-timer`, `finished`, `failed`, `cancelled`, `continued`).
- `phases`/`nodes.phase`/`nodes.kind`: computed by the persisted-frame variant
  of `deriveClaudeWorkflowPhases` over the latest committed frame's `xml_json`
  and `taskIndexJson`. Loop/fan-out runtime ids (`logicalId@@ralphId=N`) are
  resolved to their logical id's phase server-side.
- `changed`: nodeIds whose state differs since `--after-seq N` (computed from
  the event log). `outputs`: final output text for nodes that became terminal
  since the cursor, truncated server-side.
- `--wait`: block until any run-relevant event with `seq > N` (node/frame/run/
  approval categories), then respond. On `--timeout-ms` expiry respond with the
  current state and `timedOut: true`, exit 0. Implementation reuses the
  existing watch polling plumbing (interval poll against the adapter). Callers
  loop trivially; there is no error path to interpret.
- `continuedAs`: the replacement runId when status is `continued`
  (from `RunContinuedAsNew.payload.newRunId`).
- Exit codes: 0 on success (including timedOut), 4 RUN_NOT_FOUND, 1 contract
  errors.

### 5.2 `smithers claude node-wait <nodeId> --run-id <r> [--iteration i] [--timeout-ms M] [--max-output-chars K]`

Blocks until the node (latest iteration by default) reaches a terminal state
(`finished`, `failed`, `skipped`, `cancelled`), then prints
`{contract, nodeId, state, output, error, vanished}` and exits 0. If the node
disappears from the current frame, responds `{state: "skipped", vanished: true}`.
On timeout: `{timedOut: true, state: <current>}`, exit 0 (caller re-invokes;
this is how a watcher survives the 10-minute Bash cap on multi-hour nodes).

### 5.3 `smithers claude monitor [--store <path>]`

Long-running NDJSON follower for the plugin monitor component. Emits one line
per notable transition across local runs: `approval-pending`, `human-request`,
`run-failed`, `run-finished`, `run-stalled` (heartbeat gone stale), each with
`runId` and a one-line summary plus the resolving command. Silent (and exits 0)
when no `.smithers` store exists, so the monitor is inert outside smithers
projects.

Why a new namespace instead of extending `inspect`: these commands encode
Claude-specific grouping semantics and a frozen wire contract (`contract: 1`).
`inspect` stays human-shaped and free to evolve. The tick contract is
client-agnostic enough for the codex plugin to reuse later.

## 6. The generic mirror script (`claude-plugin/workflows/smithers-run.mjs`)

One script for every workflow, checked into the plugin, versioned with it. The
only coupling to the CLI is the `contract: 1` JSON shape; the script refuses
(with a clear `log()` and a graceful return) any other major contract.

```
meta = { name: 'smithers-run',
         description: 'Launch or attach to a durable Smithers run and mirror it live',
         phases: [{ title: 'Run' }] }            // real phases arrive at runtime

args (object or JSON string; normalize):
  { runId }                                       // attach mode
  { workflow, input?, cwd? }                      // launch mode
  { mirrorAllNodes?, maxLiveWatchers?, agentBudget? }

CLI = args.cwd ? `cd <quoted cwd> && bunx smithers-orchestrator` : `bunx smithers-orchestrator`

// Launch mode: one schema-forced agent runs exactly
//   ${CLI} workflow run <workflow> --detach [--input <json>] --format json
// and returns { runId }. log() the runId and the `smithers ui` hint.

seenPhases, mirrored = Set(); pending = []; live = 0; spawned = 0; seq = 0
MAX_LIVE   = args.maxLiveWatchers ?? 6            // slot cap is min(16, cores-2); an
                                                  // 8-core machine has 6 slots, and the
                                                  // sync agent must never queue behind
                                                  // its own watchers
BUDGET     = args.agentBudget ?? 900              // under the 1000 lifetime cap
COLLAPSE_AT = 150                                 // nodes-per-frame threshold

while (true) {
  tick = await agent("Run exactly this command once and return its JSON as structured output:\n" +
                     `RUN-EXACTLY: ${CLI} claude tick <runId> --after-seq ${seq} --wait --timeout-ms 420000 --format json`,
                     { label: 'sync', phase: 'Run', schema: TICK_SCHEMA, model: 'haiku', effort: 'low' })
  if (!tick) break
  seq = tick.seq
  for (p of tick.phases) if new: phase(p.title)
  if (tick.nodes.length > COLLAPSE_AT) -> switch to per-phase summary rows (log it) 
  for (n of tick.nodes) where shouldMirror(n) and not mirrored:
    if n.state is running/pending and live < MAX_LIVE and spawned < BUDGET:
      mirrored.add; live++; spawned++
      (fire, don't await) agent("Watch one node. Run exactly, re-running on timedOut:true up to 40 times:\n" +
            `RUN-EXACTLY: ${CLI} claude node-wait <n.nodeId> --run-id <runId> --timeout-ms 480000 --format json\n` +
            "Return the final output text, or [skipped] / [failed: <error>]. Observe only.",
            { label: n.label, phase: n.phase, model: 'haiku', effort: 'low' }).finally(live--)
    else if n.state is terminal (arrived in tick.outputs):
      mirrored.add; spawned++
      (fire) agent("Return exactly this text and nothing else:\nRETURN-EXACTLY:\n" + tick.outputs[n.nodeId] ?? `[${n.state}]`,
            { label: n.label, phase: n.phase, model: 'haiku', effort: 'low' })   // 1-turn echo row
  for (a of tick.approvals) if new: log(`⏸ approval needed on ${a.nodeId}: ${a.title} — resolve with resolve_approval or \`smithers approve\``)
  if (tick.status === 'continued' && tick.continuedAs) { log(`run continued as ${tick.continuedAs}; following`); runId = tick.continuedAs; seq = 0; continue }
  if (tick.status is terminal) { final echo pass for any missed terminal nodes; break }
  if (spawned >= BUDGET) { log('agent budget reached; remaining nodes summarized per phase'); collapse }
}
await all pending watcher/echo promises (each already .catch()ed to null)
return { runId, status, mirroredCount, failedNodes }
```

Behavior notes:

- `shouldMirror`: agent-kind and human/approval-kind nodes by default (they are
  the ones with meaningful duration and output), plus every node whose logical
  id is absent from the frame-0 index (dynamic fan-out). compute/static rows
  need `mirrorAllNodes: true`. Same default as PR #462, now computed
  server-side.
- Live watcher rows appear when the smithers node starts and resolve when it
  finishes: a true live mirror. Each holds one slot but spends its life blocked
  on a single `node-wait` call, 1-2 turns total. Overflow beyond MAX_LIVE
  degrades to a 1-turn echo row at completion (row appears late; still
  complete). This bounds slot pressure so `sync` always has a slot.
- Watcher and echo calls are fired without `await` (each promise is collected
  and `.catch()`ed); the sync loop must never block on them, and the script
  awaits the collected set once the run is terminal so no row is abandoned.
- `RUN-EXACTLY:` / `RETURN-EXACTLY:` prompt markers are a deliberate,
  machine-checkable convention; the test harness executes them (section 10).
- Nothing in the loop parses smithers state by prose. The tick response is the
  single source of truth; the tested oracle and the executed code are the same
  code, in the CLI.

Agent-call cost per run: `1 (launch) + T (ticks, one per change-batch thanks to
--wait coalescing) + min(N_mirrored, budget) watcher/echo rows`, each 1-2
haiku/low turns. A 10-node run is roughly 15 short agent calls; a 100-node run
roughly 130. PR #462 spent up to 300 polling turns per node plus two agents per
frame.

## 7. Plugin wiring (the default-on part)

Shipped in `claude-plugin/`:

1. **`workflows/smithers-run.mjs`** as above. Plugins have no native workflows
   component, so the script is plain plugin cargo referenced by absolute path.
2. **SessionStart hook** (`hooks/hooks.json` + `hooks/announce-mirror.mjs`):
   prints one context line so every session knows, without any lookup:

   > Smithers live view: run durable work as a detached smithers run, then
   > mirror it into /workflows with
   > `Workflow({scriptPath: "<CLAUDE_PLUGIN_ROOT>/workflows/smithers-run.mjs",
   > args: {workflow: "<id>", input: {...}}})` or `args: {runId: "..."}` to
   > attach. Active local runs: <n>.

   `${CLAUDE_PLUGIN_ROOT}` is resolved by the hook runtime, so the path is
   always the currently-installed version; `scriptPath` is read once at launch,
   so mid-session updates cannot break an in-flight mirror. The active-run
   count comes from a best-effort `bunx smithers-orchestrator ps --format json`
   with a 2s timeout, silent on failure, so the hook never blocks a session.
   Fallback if the context line was compacted away: the skill documents the
   glob `~/.claude/plugins/**/smithers*/workflows/smithers-run.mjs`.
3. **Monitor** (`monitors/monitors.json`, `experimental.monitors`):
   `bunx smithers-orchestrator claude monitor`. Approval requests, failures,
   and completions reach the main loop as notifications even when no mirror is
   running, and Claude relays approvals to the human (`AskUserQuestion` →
   `resolve_approval`). Monitors are experimental and interactive-only; the
   design treats them as an enhancer, never a dependency.
4. **`.mcp.json`** unchanged (`bunx smithers-orchestrator --mcp`).
5. **Skill rewrite** (`skills/smithers/SKILL.md`), the load-bearing rules:

   - Keep: durable/multi-step/background work runs in smithers, never
     hand-rolled Task/Agent trees or `/loop`.
   - Replace the blanket Workflow-tool ban with a carve-out: "Claude Code's
     native Workflow tool is used for exactly one thing: launching the shipped
     `smithers-run.mjs` mirror script so the human watches the run in
     /workflows. Never author ad-hoc Workflow scripts for durable work."
   - The standard flow: (1) pick or author the workflow, (2) invoke the
     Workflow tool with the mirror script in launch mode (it starts the
     detached run itself and logs the runId), (3) offer `smithers ui` for the
     browser surface, (4) relay approvals when the mirror or monitor surfaces
     them, (5) report the run's outcome from the mirror's return value.
   - On session start/resume with active runs (hook line): offer to re-attach
     a mirror with `args: {runId}`.
   - The mandatory custom gateway-react UI rule stays for workflows Claude
     authors; the mirror is the zero-config baseline that exists even before
     any UI is written.

Non-plugin users: `smithers init` additionally seeds
`.claude/workflows/smithers-run.mjs` (same file) so `Workflow({name:
"smithers-run"})` resolves by name in initialized repos. Cheap, and covers
people who install the CLI without the plugin.

## 8. Lifecycle coverage

| Event | Mirror behavior |
| --- | --- |
| Approval / human request | tick surfaces it; `log()` line with the resolving command; monitor notifies the main loop; run status `waiting-approval` keeps the sync loop parked on `--wait` |
| Node failure | watcher row resolves `[failed: <error>]`; run failure ends the loop with status in the return value; skill points at `smithers autopsy` |
| Continue-as-new | followed: tick returns `continuedAs`, script swaps runId and keeps mirroring (PR #462 stopped) |
| Node skipped / vanished | `node-wait` returns `{state: skipped, vanished: true}`; row resolves `[skipped]` (append-only tree) |
| Run cancelled from smithers side | tick status `cancelled`; loop ends cleanly |
| Mirror stopped from Claude side (TaskStop / session end) | the smithers run is unaffected (durable, detached); skill instructs re-attach via `args:{runId}`; actually killing the run is explicit (`cancel_run` MCP / `smithers cancel`) |
| Huge runs | per-frame node count > 150, or agent budget reached: collapse to one summary row per phase, always `log()`ed (no silent caps) |
| Quota-stalled / heartbeat-stale run | monitor emits `run-stalled`; tick keeps reporting last known state |

## 9. Fate of PR #462 code

| PR artifact | Fate |
| --- | --- |
| `packages/graph/deriveClaudeWorkflowPhases` + types + tests | keep; add persisted-frame variant (input: `xml_json` string + task index rows) used by `claude tick` |
| `apps/cli/src/claude-workflow/mirrorState.js` + tests | logic moves into the `claude tick` implementation (it becomes the executed code, not a prompt approximation); tests adapt |
| `--emit-claude-workflow`, template, output-path resolver, generator tests | delete; superseded by the generic script |
| real-run e2e harness (fake agent, detached run, data-dependent fan-out) | keep the pattern; re-target at `claude tick`/`node-wait` |
| `docs/examples/claude-workflow-mirror.mdx` + gif | replace with `docs/integrations/claude-code.mdx` documenting the plugin, default-on mirror, monitor, and skill flow; regenerate llms bundles |
| PR #462 itself | close with a comment linking this spec; the branch's graph + mirrorState work lands via the new implementation |

## 10. Testing (no mocks, CI-safe)

CI has no agent CLIs, no browsers, no Claude Code session. Everything below
runs on seeded real stores and the real CLI binary.

1. **Unit: tick computation.** Real adapter over a seeded store (the
   fake-agent seeding path used across apps/cli tests): assert phases/kinds
   from persisted frames match `deriveClaudeWorkflowPhases` over the same
   frame, `changed`/`outputs` deltas against `--after-seq` cursors, truncation,
   approval surfacing, `continuedAs`, RUN_NOT_FOUND, timedOut shape.
2. **E2E: live run.** Start a detached run (fake agent) with a data-dependent
   `<Parallel>` fan-out; drive `claude tick --wait` in a loop from the test;
   assert the fan-out nodes appear across ticks, `node-wait` blocks and
   returns terminal output, a vanished node reports `vanished`, and the run's
   terminal tick closes the sequence. Fault case: `node-wait` on a node that
   never starts respects `--timeout-ms`.
3. **E2E: the script itself.** A harness (bun test, real CLI, real store)
   executes `smithers-run.mjs`'s body with the runtime globals implemented as:
   `agent(prompt)` extracts the `RUN-EXACTLY:` command and execs it (returning
   parsed JSON when a schema is given) or returns the `RETURN-EXACTLY:` block
   verbatim; `phase`/`log` record; `parallel` = Promise.all. The script's real
   control flow runs against a real detached run end to end; assertions cover
   phase registration order, watcher-vs-echo classification, budget collapse,
   continue-as-new follow, and the return value. The only simulated component
   is the LLM, which CI cannot have; every command and every byte of state is
   real.
4. **Contract freeze.** A golden-shape test pins the `contract: 1` response
   (field names, enums) so CLI evolution cannot silently break shipped plugin
   scripts.
5. **Plugin.** `claude plugin validate` in CI; hook script unit test (context
   line shape, 2s ps timeout, silence without a store); monitor smoke test
   (NDJSON shape from a seeded store).
6. **Manual, pre-release:** run the mirror through a real Claude Code session
   against a live run (the PR #462 gif flow) as a release checklist item.

## 11. Failure modes and degradation

| Failure | Behavior |
| --- | --- |
| smithers CLI not installed | `bunx smithers-orchestrator` bootstraps from npm (first call slow); skill preflights with `--version` before launching a mirror |
| `.smithers` not initialized | skill runs the durable `init` workflow first; `claude tick` on a missing store exits 4 with an actionable message the sync agent surfaces via its row |
| Store backend gaps (pglite CLI reads) | tick rides `findAndOpenDb`, so it inherits the pluggable-DB fixes; sqlite (default) works today; document the dependency |
| DB locked by the detached engine | same retry/interval story as `inspect --watch` today (sqlite WAL + retryable-write handling); tick is read-only |
| MCP server absent (headless) | irrelevant to the mirror: everything is CLI-over-Bash; MCP is only used by the skill for control actions, with CLI equivalents documented |
| Plugin newer/older than CLI | `contract` mismatch: script logs "update the smithers plugin / smithers-orchestrator" and returns gracefully; contract v1 is frozen |
| Monitor unsupported (old Claude Code, non-interactive) | monitors are additive; mirror and skill work without them |
| SessionStart context compacted away | skill's documented glob fallback locates the script |

## 12. Open questions

1. `~/.claude/workflows/` user-global name resolution: PR #462's working spec
   asserts it works; the current public docs only confirm project
   `.claude/workflows/`. If confirmed, `smithers init --global` could seed the
   script user-wide and `Workflow({name})` replaces scriptPath everywhere.
   Verify once against a live Claude Code before relying on it.
2. Should `run_workflow` (MCP) gain a `mirror: true` convenience that returns
   the exact Workflow-tool invocation for the model to execute? Pure sugar on
   top of the skill flow; decide after dogfooding.
3. Monitor scope: all local stores vs the current project only. Start with the
   current project (cwd store) to avoid cross-repo noise.
4. Whether `claude tick` should also stream node token usage / cost so the
   mirror rows can show it (gateway already aggregates usage). Nice for later;
   not v1.
