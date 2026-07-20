# Durable agent snapshots + session continue on restart

Status: proposed, LGTM by codex (4 review rounds: durability contract honesty,
jj operation_id durability + gc, non-mutating restore recipe, spooled fail-open
hooks, states/checkpoints split, sandbox honesty, reconciliation backstop)
Related: `packages/vcs`, `packages/engine`, `packages/agents`, `packages/smithers/src/tools`, `packages/time-travel`, `packages/db`, `packages/sandbox`, `apps/cli`

## Goal

1. **No silent leaks.** Every file mutation in an agent's worktree is either
   captured as a restorable jj snapshot, or recorded as an explicit
   `DurabilityGap` (durably, even if the engine itself is the thing that died).
   Detected gaps are durable; periodic reconciliation backstops what live watching
   can miss. Byte-perfect capture of everything has real
   limits (ignored files, out-of-tree writes, large files, background writers);
   those are handled by explicit policy, not pretended away.
2. **Coherent continue on restart.** A re-spawned run resumes its agent session
   against a workspace restored to the checkpoint that matches what the session
   transcript believes happened, not just "latest on disk."

## Durability contract (three tiers)

- **Tier 1, strict + consistent + transcript-aligned.** A snapshot taken at a
  boundary where the tree is genuinely quiescent: an in-process file tool wrap, or
  a CLI file-edit tool hook, or a foreground shell command whose **whole process
  group is confirmed dead**. These are the only valid **restore targets** for
  continue-on-restart. A shell/tool boundary that may have spawned background or
  detached writers is **not** Tier 1 (smithers' bash and sandbox runners spawn
  detached children: `packages/smithers/src/tools/bash.js:151`,
  `packages/sandbox/src/effect/process-runner.js:272`). Those are Tier 2 unless
  smithers waits on or kills the full process group first.
- **Tier 2, best-effort + bounded-latency.** The filesystem watcher snapshots
  settled tracked files in the worktree, including writes from shell subprocesses
  and background processes. Async, so a crash between a write landing and the
  snapshot loses that window, and a write-then-delete inside the debounce window
  is not separately captured. A stability check (size and mtime unchanged across a
  short interval) avoids snapshotting a file mid-write. Background-writer states
  are best-effort by definition.
- **Tier 0, durable detected gaps.** Every gap we DETECT is recorded as a
  `DurabilityGap`, written to a local spool file first (so it survives an engine
  crash) and ingested into the DB on restart: snapshot timeout, a hook that could
  not reach the engine, a file refused for size, a tool-reported out-of-tree
  target, a watcher-reported ignored-path mutation. We cannot detect an arbitrary
  ignored-path write the watcher never delivers, so "no silent leaks" is backed by
  **periodic reconciliation**: a sweep of declared `trackPaths` plus tracked
  working-copy state, plus a watcher-health / lost-event check that emits a gap when
  the watcher falls behind. Literal detection of every ignored mutation needs the
  sandbox mode.

Scope and policy (the limits jj imposes):

| case | default | policy |
| --- | --- | --- |
| ignored paths (`node_modules`, `dist`, build output, logs) | not snapshotted (jj never auto-tracks ignored files) | optional `durability.trackPaths` allowlist force-tracks declared artifacts; an ignored-path mutation emits `DurabilityGap` |
| new file over `snapshot.max-new-file-size` (jj refuses, default ~1MiB) | refused | raise the cap via per-run jj config; over the cap emits `DurabilityGap` |
| writes outside the worktree (`/tmp`, `$HOME`, absolute paths, symlinks out) | out of scope | emit `DurabilityGap` when a tool reports an out-of-tree target; literal in-tree no-leaks needs a **new** sandbox mode (writable-worktree jail). Current `packages/sandbox` mounts the bundle read-only and a separate `/result` writable (`process-runner.js:318`,`:402`); it is bundle/result isolation, not a worktree write-jail, so this is future work, not an available toggle. |

Out of scope entirely: strict per-syscall WAL for arbitrary subprocess writes
(FUSE / fanotify-perm; rejected for macOS hostility, IO tax, complexity).

## Two tables (states vs checkpoints)

Separating the jj handle from the logical event removes the dedup/restore
conflict and simplifies labeling.

- `_smithers_workspace_states`: the deduped jj handles. Key `(jj_cwd, commit_id)`.
  Columns: `jj_cwd, jj_commit_id, jj_operation_id, jj_change_id, created_at_ms`.
  One row per distinct working-copy state.
- `_smithers_workspace_checkpoints`: one row per boundary event, never deduped.
  Columns: `run_id, node_id, iteration, attempt, seq, state_id (fk),
  source ("watch"|"hook"|"wrap"), tier (1|2), label?, tool_use_id?, created_at_ms`.

A Tier 1 boundary always inserts a checkpoint row (so resume always has a seq to
bind to) even when the underlying state is unchanged. A watcher (Tier 2) boundary
inserts a checkpoint only when the state actually changed (no spam). The existing
per-attempt `jj_pointer` and `revert`/`rewind`/`replay` are untouched; both tables
are additive.

## One snapshot path

`SnapshotService` (new, `packages/engine`), one serial queue per worktree:

```
snapshot({ cwd, source, tier, label?, toolUseId? }):
  with a bounded timeout (generalize the 1.5s getJjPointer wrap into runJj):
    1. jj log -r @ --no-graph -T 'commit_id'                                  // forces ONE working-copy snapshot
    2. jj --ignore-working-copy operation log --no-graph --limit 1 -T self.id() // op handle WITHOUT a second snapshot, so commit_id and operation_id come from the same snapshot (step 1)
  upsert _smithers_workspace_states by (cwd, commit_id) -> stateId   // dedup lives here only
  if source in {hook, wrap}:    insert a checkpoint (always)
  if source == watch:           insert a checkpoint only if stateId is new
  on timeout / jj error:        write a DurabilityGap to the spool, return; never throw into the agent path
```

jj mechanics, corrected against jj reality (verified, jj 0.39 / 0.40 docs):

- `jj log -r @` **does** force the working-copy snapshot, but it is **not
  read-only**: it rewrites `@`'s commit and records an operation. We call it
  "snapshot-only" (no `jj new`/`jj commit`, so `@` is not advanced).
- `operation_id` is the restore handle, but it is **not magically permanent**.
  `jj util gc` prunes obsolete commits and old operations by age, so a bare
  `commit_id` from an abandoned working-copy commit can disappear. Durability is
  therefore explicit: we configure jj gc retention to exceed our retention window
  and prune `_smithers_workspace_*` rows in lockstep **before** gc could collect
  the operation. Restore targets we must keep long-term (the resume-bound
  checkpoints) are additionally materialized as an independent content blob
  (tar/patch) stored **outside the worktree** (under the smithers run-state dir,
  never inside `jj_cwd`, so snapshot artifacts never become snapshot inputs for the
  watcher), so a pinned restore never depends on jj gc timing. `change_id` is
  grouping metadata only.
- Restore a checkpoint (exact, non-mutating; per codex):
  ```
  pause the watcher; confirm the agent's process group is stopped
  jj --at-op <op_id> --ignore-working-copy log -r @ -T commit_id   // read the state WITHOUT snapshotting the live tree
  jj restore --from <commit_id>                                     // in the owned worktree cwd only
  ```
  Never `jj op restore` (it restores whole-repo operation state across sibling
  worktrees). `--ignore-working-copy` is required so the read does not snapshot the
  current tree and mint a new operation. Restore overwrites newer tracked state
  (intended) and does not remove ignored/untracked files (governed by the artifact
  policy). If the jj op is gone, fall back to the materialized blob.

## Layer 2: filesystem watcher (Tier 2 substrate)

- Watchman or `@parcel/watcher` on the worktree, **ignore `.jj/` and `.git/`**
  (mandatory: jj writes metadata on snapshot; watching it would loop).
- Trailing-idle debounce (~150ms) plus the stability check before
  `snapshot({ source: "watch", tier: 2 })`.
- jj fsmonitor is an **optional perf** setting, version-gated: newer jj uses
  `fsmonitor.backend = "watchman"` (older used `core.fsmonitor`). Detect at
  runtime; skip if unsure (we trigger snapshots ourselves; fsmonitor only speeds
  jj's own scan).
- Catches subprocess and background writes to tracked in-worktree files. Its
  limits are the Tier 2 / Tier 0 caveats above, stated.

## Layer 1: tool-boundary snapshots (Tier 1, and why it earns its complexity)

Same `SnapshotService`, triggered at a quiescent boundary, producing a
consistent, transcript-aligned checkpoint. This is what makes
continue-on-restart correct: watcher snapshots are not aligned to tool boundaries
or the transcript, so they are unsafe restore targets for a resumed session. Layer
1 earns its place on restart coherence, not on completeness (Tier 2 covers
completeness best-effort).

### In-process agents (proven core)

`AnthropicAgent`/`OpenAIAgent`/`HermesAgent` run the AI SDK in-process and call
smithers' own tools via `defineTool()` (`packages/smithers/src/tools/defineTool.js`).
After a `sideEffect: true` tool's `execute` resolves and before returning to the
SDK, call `snapshot({ source: "wrap", tier: 1, ... })` synchronously. True
in-process WAL boundary, no IPC. For the `bash` tool, only tier 1 if the command's
process group is confirmed dead; otherwise tier 2.

### CLI agents (deferred, unproven until integration-tested)

Each CLI agent's native blocking hook runs one thin command, `smithers
snapshot-hook`, reading the hook JSON on stdin plus injected env correlation and
connecting to a per-run unix socket the engine listens on. Hardening:

- **Bounded + fail-open + spooled.** The hook waits at most N seconds. On timeout
  or an unreachable/crashed engine it **writes a DurabilityGap (or pending
  snapshot request) to a local spool file, then exits 0.** The agent is never hung;
  Tier 0 holds even when the engine is the casualty, because the engine ingests the
  spool on restart.
- **Seq-ordered, never deduped away.** Tier 1 checkpoints always insert a row
  (states table dedups; checkpoints table does not), so a racing watcher snapshot
  can never erase the row resume needs.

New optional capability on `AgentLike`: `prepareDurability(spec) -> { env?, args?,
files?, cleanup? } | null`, per-spawn injection installing the native hook (staged
in a temp dir, user global config untouched) or `null` (watcher-only). Treat every
CLI hook row as **unimplemented until an integration test proves it**.

| agent | mechanism | status |
| --- | --- | --- |
| Anthropic/OpenAI/Hermes (in-process) | `defineTool` wrap | proven core (Phase 2) |
| ClaudeCodeAgent | PostToolUse hook via `--settings` | deferred (Phase 3), verify |
| GeminiAgent | AfterTool hook via staged settings | deferred, verify |
| OpenCodeAgent | `tool.execute.after` plugin | deferred; subagent bypass (#5894), MCP hooks (#2319) |
| AmpAgent | `tool.result` plugin | deferred, verify coverage |
| KimiAgent | PostToolUse hook | deferred; hooks fail-open |
| CodexAgent | watcher-only | apply_patch/MCP hooks unreliable (#20204) |
| Pi/Vibe/Forge/Antigravity | watcher-only | no proven hook |

Every agent is covered at Tier 2 by the watcher. Layer 1 upgrades an agent to Tier
1 (restartable) only where its hook is proven.

## Restore + session continue (coherent)

- Each time the engine heartbeats the resume token (`attemptMeta.agentResume`,
  `engine.js` ~3121-3128), also record the **Tier 1 checkpoint seq** known to
  include all completed tool effects. This binds "what the transcript believes" to
  "what is on disk."
- On a resumed attempt, before `agent.generate`: pause the watcher, confirm the
  prior process group is dead, restore the owned worktree to the bound seq's state
  (via the `--ignore-working-copy` recipe, or the materialized blob), then
  continue. If no Tier 1 checkpoint is bound (watcher-only agent), do not silently
  resume onto an unaligned tree: start fresh, or proceed with an explicit mismatch
  warning.
- Continue mechanism: prefer `--resume <id>` when a captured session id exists. Use
  `--continue` only when smithers can prove **exactly one** matching prior session
  for that cwd/run/node (stable cwd alone does not prove the CLI will pick the
  transcript matching the bound snapshot); otherwise fresh or warn. Needs a new
  `continueSession` option on `AgentLike` mapped per agent; today only
  `resumeSession` is plumbed and `ClaudeCodeAgent` exposes a static `opts.continue`
  (`ClaudeCodeAgent.js` ~386/421), so this is new work. The supervisor
  (`spawnResumeDetached`) only re-launches; restore + continue happen inside the
  resumed attempt.

## Phases (each PR-sized, tests green, shippable)

1. **Snapshot path + watcher (Tier 2 + Tier 0).** `SnapshotService` (bounded
   timeout, two-table model, spool for gaps), `_smithers_workspace_states` +
   `_smithers_workspace_checkpoints` + migration, watcher (ignore `.jj`/`.git`,
   debounce + stability), per-run jj config (size cap, version-gated fsmonitor),
   gc-retention + lockstep prune, flag `durability.snapshots` (default off). Tests:
   external process writes N tracked files -> state+checkpoint rows; ignored
   mutation -> spooled `DurabilityGap`, no row; torn file not captured; `.jj` does
   not loop; jj-missing -> gap, never throw; gc retention keeps a referenced op for
   the configured window.
2. **In-process tool wrap (Tier 1 for SDK agents).** `defineTool` snapshots after
   `sideEffect` tools; bash only tier 1 if process group confirmed dead. Tests:
   edit -> labeled tier-1 checkpoint before next step even if state unchanged;
   snapshot failure does not fail the tool.
3. **CLI hook injection (Tier 1 per agent, deferred).** `prepareDurability`,
   per-run unix socket, `snapshot-hook` subcommand (bounded, fail-open, spooled);
   Claude + Gemini first, behind integration tests. Tests: labeled tier-1 rows on a
   real run; kill engine mid-hook -> agent continues + spooled gap ingested on
   restart; global config untouched.
4. **Restore + continue bound to seq.** Heartbeat resume token with its Tier 1
   checkpoint seq; pause-restore-continue on resume (process group dead first);
   `continueSession` with exactly-one-session proof. Tests: kill mid-turn after a
   tier-1 boundary, resume -> worktree restored to bound seq, transcript and disk
   agree; missing seq -> fresh or warn, never silent corrupt; blob fallback when
   the jj op was gc'd.
5. **Surface + docs.** `smithers snapshots <runId>`, `smithers restore --to <seq>`,
   surface in `smithers timeline`; document the three tiers and artifact policy in
   `docs/why/durable-open-orchestration.mdx`, `docs/how-it-works.mdx`.

## Open questions

1. Retention numbers: jj gc retention window vs our prune cadence vs blob-pin
   threshold. What is the default keep window for non-pinned (scrubbing) snapshots?
2. Blob materialization cost for pinned restore targets on large trees: tar vs jj
   `diff`-based patch. Measure before fixing.
3. Process-group liveness check for Tier 1 bash boundaries: cheapest reliable way
   to confirm a command spawned no surviving detached writer.
4. Is Phase 3 (CLI hooks) worth it, or do we restart CLI agents fresh on a watcher
   snapshot with a warning and ship only Phases 1, 2, 4-for-in-process?
