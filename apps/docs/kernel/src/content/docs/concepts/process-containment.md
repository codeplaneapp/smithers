---
title: "Process containment"
description: "How the kernel makes a cancelled run leave no process behind: the SIGTERM-then-SIGKILL deadline, the durable process ledger, and the orphan records a dead host hands its successor."
sidebar:
  order: 4
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/kernel/docs/concepts/process-containment.md"
---

Cancelling a run must leave no process running. Two separate failures can
break that, and `ContainedSpawner` closes both.

## A cancellation that never finishes

Effect's spawner already signals a child's process group when the spawn scope
closes, and then waits for the exit. With no `forceKillAfter` configured, it
waits forever. A child that traps `SIGTERM`, or a child whose own children trap
it, turns a cancellation into a hung host: the releasing fiber never finishes,
the run never reaches `cancelled`, and the process stays on the machine.

`ContainedSpawner.layer` rewrites every command it spawns to carry an
escalation deadline: `SIGTERM`, then `SIGKILL` after `graceMs`, which defaults
to `ContainedSpawner.defaultGraceMs` (2,000 ms). Both legs of a pipeline get
the policy. A command that already names its own `killSignal` or
`forceKillAfter` keeps the policy its caller chose.

The spawner does not signal anything itself. Killing a live child is Effect's
job, and Effect does it correctly once a deadline exists. This module supplies
the deadline and the memory, which is why it lives in the kernel beside the
`proc:spawn` decorator over the same tag rather than in one platform bundle:
Node and Bun compose the same middleware.

## A host that dies before its finalizers run

The second failure is a crash. No finalizer runs, so nothing signals the
children, and the next incarnation of the host has no idea they exist.

`ProcessLedger` is the durable memory that fixes it. Every successful spawn is
recorded, and the record is released when the spawn's scope closes. Records
are ownerless journal entries on the run `flows.host:<hostId>` under the
source id `@smthrs/kernel/ProcessLedger`, with four event types:

| Event type                           | Meaning                                                   |
| ------------------------------------ | --------------------------------------------------------- |
| `flows.host.process-spawned.v1`      | This host started the process.                            |
| `flows.host.process-exited.v1`       | The process ended and its scope released it.              |
| `flows.host.process-reaped.v1`       | An abandoned process group was signalled by a later host. |
| `flows.host.process-reap-skipped.v1` | A later host refused to signal it, and why.               |

The next incarnation of the same host replays that history, folds the exit,
reap, and skip events onto the spawn events, and reads `orphans`: the records
whose owner pid is not this incarnation's. `ProcessLedger.layerMemory` keeps
only the current incarnation's bookkeeping, with no journal and nothing
inherited.

## A failed write is reported, never swallowed

`record`, `release`, `reaped`, and `skipped` all carry the journal's failure to
their caller. A swallowed write would leave a child no incarnation of the host
can discover, which is the exact outcome containment exists to prevent.

The spawner acts on that. A spawn whose durable record fails is signalled, the
call fails, and no pid is left in `ProcessLedger.live`. Keeping it live would
lie to every later reader about a process this incarnation still holds.

The release finalizer is the one exception, because it has nowhere left to
report. It is registered **before** the spawn, so scope closure runs it after
Effect's own kill finalizer: the exit is announced only once the process has
been signalled. If the release write still fails after its retries, the record
stays inherited rather than claiming that a possibly live process exited, and
the next reaper finds the pid already gone and retires it then.

## Reaping is deliberately conservative

Signalling a process group you did not start is dangerous: a pid can be
recycled. [`@smthrs/platform-node`](https://platform-node.smithers.sh/reference/api/)'s `ProcessReaper`
therefore signals an orphan only after every one of these holds:

- The record names a **separate** process group, not the reaping host's own
  group, and the group is a plausible one the child leads.
- The owner is genuinely gone.
- The record belongs to the current boot. A record written before this machine
  booted names a pid from a pid space that no longer exists.
- Where the platform can read it, the pid's start time still matches.

A successful reap and a safety refusal retire the record through **different**
event types, so an operator reading the journal can tell "we killed it" from
"we declined to". A failed signal or a still-live owner leaves the record for a
later attempt.

`ContainedSpawner.groupOf(command, pid, platform)` decides what group to
record, and it takes the platform because Effect detaches a child that names
no `detached` option everywhere except win32. A win32 record claiming
`pgid === pid` would name a group the child does not lead, so it records no
group at all instead.

## The grant identity is the command line alone

Containment and authorization are separate concerns over the same tag, but
they share one fact worth stating here. A spawn is checked as `proc:spawn`
with `CommandLine.render(command)` as its resource, and that rendered line is
the whole grant identity. The working directory, the environment overrides,
and a pipeline's `from` and `to` routing are **not** part of what the grant
authorizes. The working directory and the _names_ of overridden environment
variables reach an attended surface as display metadata; the values do not.

A custom shell path is explicit in the rendered line, and a pipeline renders
with `|` between its stages, so neither can hide behind a grant for something
else. The derived helpers (`exitCode`, `string`, `lines`, and both `stream`
forms) are all rebuilt from the guarded `spawn`, so none of them can bypass the
check.

## Related

- [Contain spawned processes](/guides/contain-spawned-processes/): the
  composition, with and without a journal.
- [How a grant decision is made](/concepts/grant-decisions/): the check that runs
  before any of this.
