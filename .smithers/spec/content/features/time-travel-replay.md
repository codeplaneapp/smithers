# Time travel, rewind, replay, and snapshots

> **Status:** Partial | **Priority:** P1 | **Owner:** smithers-maintainers | **Group:** Recover & replay

Time-travel APIs and CLI commands capture snapshots, diff frames, rewind runs, fork branches, replay from checkpoints, restore attempts, and tag VCS revisions against persisted run history.

## What you can do

Step back through a run, inspect what changed, fork another path, or restore a checkpoint without rerunning everything from scratch.

## Capabilities

### Rewind & fork

rewind\_run, fork\_run, replay\_run over the persisted event log.

### Snapshots

jj-based durability snapshots (phase 1) behind SMITHERS\_DURABILITY\_SNAPSHOTS.

### Snapshot and diff

captureSnapshot/listSnapshots/loadSnapshot plus diffSnapshots power CLI snapshots, diff, and timeline views.

### Rewind and restore

rewind, timetravel, restore, revert, and retry-task mutate persisted state to recover from bad attempts.

### Fork and replay

forkRun, replayFromCheckpoint, and branch metadata create alternate timelines.

### VCS tags

time-travel can tag snapshots to git/jj revisions and rerun at a revision when the VCS plumbing is available.

## Endpoints and commands

- `CLI smithers rewind` ([docs](docs/cli/overview.mdx))
- `CLI smithers fork` ([docs](docs/cli/overview.mdx))
- `CLI smithers replay` ([docs](docs/cli/overview.mdx))
- `CLI smithers snapshots` ([docs](docs/cli/overview.mdx))
- `RPC rewindRun` ([docs](docs/rpc/rewind-run.mdx))

## Related docs

- [Time-travel recipes](docs/recipes.mdx#time-travel-fork-replay-diff)
- [Runtime revert](docs/runtime/revert.mdx)

## Test cases

- `packages/time-travel/tests/time-travel-replay.test.js`
- `packages/time-travel/tests/revert.test.js`
- `packages/time-travel/tests/snapshot.test.js`
- `packages/time-travel/tests/timeline.test.js`
- `apps/cli/tests/rewind.test.js`
- `apps/cli/tests/snapshots-restore.test.js`
- `apps/cli/tests/up-rewind-recovery.e2e.test.js`
- `e2e/faults/case11-frame-scrub-view-only.test.ts`
- `e2e/faults/case12-rewind-reverts-vcs.test.ts`
- `e2e/faults/case24-replay-unsafe-approval.test.ts`

## Observability

- Time-travel metrics include snapshotsCaptured, runForksCreated, replaysStarted, and snapshotDuration.
- Rewind audit rows are persisted in \_smithers\_time\_travel\_audit for production incident review.

## Debugging

- Use smithers timeline, snapshots, diff, tree --frame, rewind, and replay to inspect historical frames and restore state.
- Use e2e rewind and replay fault cases before changing snapshot, audit, or VCS restore logic.

## Architecture

- `packages/time-travel/src/index.js` exports snapshot, diff, fork, replay, timeline, VCS tag, jump, lock, rate-limit, and audit helpers.
- `apps/cli/src/rewind.js`, restore.js, reportReplayResult.js, and command handlers expose the APIs to operators.
- `packages/vcs` supplies jj/git pointer capture and restore for filesystem-aware rewind.

## Fixes and diffs

- 2026-07-06 refresh: read README.md, package exports, selected package entry points, `docs/how-it-works.mdx`, `docs/cli/overview.mdx`, `docs/agents/overview.mdx`, `docs/integrations/custom-ui.mdx`, `docs/integrations/mcp-server.mdx`, `docs/deployment/production-hardening.mdx`, `docs/deployment/control-plane.mdx`, and targeted test inventories.
- `packages/time-travel/src`
- `packages/vcs/src/jj.js`
- `apps/cli/src/rewind.js`
- `apps/cli/tests/rewind.test.js`
- `e2e/faults/case12-rewind-reverts-vcs.test.ts`

## Open gaps

- Durability snapshots phase 2 for restore in test-only tool context is not finished.
- Unsafe approval replay protection has e2e coverage but needs continued review whenever approval persistence changes.
