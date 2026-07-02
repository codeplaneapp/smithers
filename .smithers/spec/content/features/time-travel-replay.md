# Time travel and replay

> **Status:** Partial | **Priority:** P1 | **Owner:** smithers-maintainers | **Group:** Recover & replay

Rewind, replay, fork, snapshot, and checkpoint-restore over persisted runs (`packages/time-travel` plus MCP tools). Core operations work; durability snapshots for agent worktrees are phased in behind a flag.

## What you can do

Step back through a run, fork it, and try a different path without rerunning everything.

## Capabilities

### Rewind & fork

rewind\_run, fork\_run, replay\_run over the persisted event log.

### Snapshots

jj-based durability snapshots (phase 1) behind SMITHERS\_DURABILITY\_SNAPSHOTS.

## Test cases

- `pnpm -C packages/time-travel test`

## Open gaps

- Durability snapshots phase 2 (restore in test-only tool context) is not finished
