# Time travel and replay

> **Status:** Partial · **Priority:** P1 · **Owner:** smithers-maintainers · **Group:** Recover & replay

**What you can do:** Step back through a run, fork it, and try a different path without rerunning everything.

Rewind, replay, fork, snapshot, and checkpoint-restore over persisted runs (packages/time-travel plus MCP tools). Core operations work; durability snapshots for agent worktrees are phased in behind a flag.

## Capabilities

### Rewind & fork

rewind_run, fork_run, replay_run over the persisted event log.

### Snapshots

jj-based durability snapshots (phase 1) behind SMITHERS_DURABILITY_SNAPSHOTS.




## Test cases

- pnpm -C packages/time-travel test

## Observability

_None recorded yet._

## Debugging

_None recorded yet._

## Architecture

_None recorded yet._

## Fixes & diffs

_None recorded yet._

## Open gaps

- Durability snapshots phase 2 (restore in test-only tool context) is not finished

