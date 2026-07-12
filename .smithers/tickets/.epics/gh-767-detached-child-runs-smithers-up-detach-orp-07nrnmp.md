# Detached child runs (smithers up --detach) orphan on parent cancel: runaway fan-out, no lifecycle binding or cascading cancel

GitHub: https://github.com/smithersai/smithers/issues/767

## Summary

A workflow whose agents launch child runs with `smithers up --detach` creates child runs that are **not bound to the parent's lifecycle**. When the parent run is cancelled, the detached children keep running as orphaned processes. There is no built-in way to say "run this child workflow as part of the parent run" (cancellable together, concurrency-bounded, resumable as one unit). The result in practice is a runaway: orphaned drivers plus their `codex`/`claude` children keep executing, exhaust model quota, and keep performing real side effects (in our case autonomous `gh issue create`), long after the parent was cancelled.

This is a control-plane correctness gap, not just an ergonomics issue. Detached sub-runs are the natural way to express "this workflow builds and runs other workflows," but today that pattern is unsafe under cancellation.

## What happened (concrete repro from a real swarm)

Parent workflow: an "issue swarm" that fans over open GitHub issues. Issues classified as **epics** were handed to an architect agent that (by design) decomposed each epic into sub-issues, authored a child `.tsx` workflow per sub-issue, and launched each with `smithers up <child>.tsx --detach`.

1. Parent run reached a wedged state (an unrelated worktree bug) and I cancelled it via `smithers cancel <runId>` and killed its driver process.
2. `smithers cancel` marked the parent cancelled, **but the detached child runs kept running**: ~30 concurrent `codex exec` processes in sibling worktree dirs (`multi-{cloud,byok,concierge}-worktrees/*`), each a child run's agent.
3. Those orphaned children continued their work, including **creating new GitHub issues autonomously** (`gh issue create`). After I cleaned up and closed the first batch of orphan-created issues (#40-52), a second batch (#53-60) appeared because the orphaned children were still alive and still creating them.
4. The orphaned fan-out also **exhausted model quota** (rate-limited the whole account), which then caused unrelated failures elsewhere.

Killing them required classifying every `codex`/`claude` process by working directory (`lsof -a -p <pid> -d cwd -Fn`, since `pgrep` cannot match on cwd) and `pkill -9`-ing by worktree-path pattern, plus manually forgetting the stray `jj` workspaces and deleting their bookmarks. None of that is discoverable or safe for a normal operator.

## Why the existing primitives don't cover it

- `smithers cancel <parent>` cancels only the parent row. It has no knowledge of child runs the parent's agents spawned out-of-band via the CLI, so it cannot cascade.
- `<Subflow>` / `<SuperSmithers>` can nest a *statically known* workflow as a node, but the "architect authors a child `.tsx` at runtime, then runs it" pattern needs to launch a **dynamically produced** child. There is no first-class "run this freshly-authored workflow file as an in-run, lifecycle-bound child node."
- Nothing links a `--detach` child back to a parent run id for cancellation, resume, or concurrency accounting.

## Proposed directions (for discussion)

1. **Lifecycle-linked child runs.** Let a run declare a child run as its dependent (e.g. `smithers up <child> --parent <runId>` or an engine API), so cancelling/pausing the parent cascades to children, and the children count against the parent's concurrency budget. Cancelling a parent should stop (or pause) its whole subtree, orphaned CLI-launched children included.
2. **"Prefer resume" / bounded relaunch semantics.** A way to relaunch a parent that reconciles with children already in flight instead of spawning duplicates: resume the parent and re-attach or resume existing children rather than starting fresh ones. (This is the "prefer resume" idea: a relaunch should prefer resuming/attaching an existing child over creating a second one, so a restart never doubles the fan-out.)
3. **Dynamic child workflows as in-run nodes.** A `<Subflow>` variant that accepts a workflow **path produced at runtime** and runs it inside the parent run (shared DB, cancellable, `subtreeConcurrency`-bounded), so "a workflow that builds and runs other workflows" is expressible without `--detach` orphans.
4. **At minimum, a cascading cancel + orphan reaper.** `smithers cancel --cascade <runId>` (and/or `smithers down` learning about parent/child links) that finds and stops child runs and their agent processes, so no manual `lsof`/`pkill`/`jj workspace forget` dance is required.

## Impact

Any workflow using the documented "build and run other workflows" pattern with `--detach` is exposed: a single cancel leaves a runaway fan-out that burns quota and performs unbounded real side effects (issue creation, pushes, file writes) with no supported way to stop it cleanly. This blocks safely running epic-decomposition / orchestrator-of-orchestrators workflows unattended.

