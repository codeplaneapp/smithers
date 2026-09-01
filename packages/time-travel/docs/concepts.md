## Rewind protocol

`rewind`:

1. validates the position before anything durable exists, so a refused frame
   leaves no claim, no audit row, and no read page behind,
2. claims and activates an inactive pending or suspended run, and holds that
   lease with a heartbeat for as long as the protocol runs, so a co-located
   engine cannot steal the run out from under a slow compensation,
3. records an audit row and the rate-limit decision,
4. loads the journal entries after the target frame,
5. resolves descendants: an attached child still depending on the truncated
   history, and a detached child under the `block` policy, both refuse the
   rewind while they are live,
6. assesses and compensates external effects, persisting each receipt before
   the next irreversible step,
7. restores the Jujutsu workspace to the frame's pointer,
8. archives and truncates the suffix atomically, fenced on the ownership claim,
9. cancels the children the policy asked for, then records completion or a
   recoverable failure.

Step 8 is the commit point. Cancelling a child is terminal and has no inverse,
so it runs only after that commit: a rewind that fails earlier leaves every
child exactly as it was. The cancellations the operator asked for are written to
the audit detail before the commit, so a crash in the middle of them is finished
by the next recovery pass instead of being silently dropped. Terminal
descendants are disclosed as warnings, because their external effects cannot be
erased by deleting a parent suffix.

Step 9 is why recovery is not an operation: building `TimeTravel.layer` finishes
or rolls back any rewind a crash interrupted, before the service accepts new
work, except one whose run a live process still holds. That one is left exactly
as the crash left it, still pending and still recoverable, so a rewind a living
process still owns is never stolen. `TimeTravel.layerWith({ isAlive })` decides
what counts as live; the default is the lease check the engine's run driver
already applies to those rows.

## Current integration boundary

The time-travel package is implemented and tested as a protocol library,
including against a journal an ordinary engine run wrote. `EngineStore`
populates the evidence it reads: it stamps `meta.lineageId` on every record,
journals a tier-2 anchor per attempt, and writes the effect-boundary records
around an irreversible dispatch and a child spawn. What a composition still
supplies by hand is the store itself, the migration that creates its tables, and
any `CompensationHandlers` its adapters own.

## What 1.0.0-rc.0 ships

Time travel is a library API in this release, and only a library API.

| Surface                                | 1.0.0-rc.0                                                                                                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TimeTravel.inspect`, `fork`, `rewind` | available from `@smthrs/time-travel`. `inspect` is the replay entry point; there is no separate `replay` operation                                             |
| CLI verbs                              | none. The Smithers 0.x time-travel verbs exit 1 with a migration message; [migrating from 0.x](/migration/1.0#removed-commands) lists them                     |
| MCP tools                              | none. `replay_run`, `fork_run`, `rewind_run`, `restore_checkpoint`, `list_snapshots`, `get_timeline`, and `time_travel` answer with the `unsupported` envelope |
| Composition                            | not composed into `NodeControl`, and the CLI does not install migration block 5000                                                                             |

A program that wants time travel provides `TimeTravelStore` and calls the
service itself. Nothing in the command line reaches it.
