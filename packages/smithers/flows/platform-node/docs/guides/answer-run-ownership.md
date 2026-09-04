---
title: "Answer whether a run owner is alive"
description: "Wire HostLiveness.isAlive as the probe the engine consults before it steals a run, understand why the rule errs toward alive, and know where the sibling implementation disagrees."
---

A durable run records the owner that holds it: a `hostId` and a pid. When
another process wants that run, it asks whether the recorded owner is still
alive. `HostLiveness.isAlive` is this package's answer.

Both ways of being wrong are expensive, and they are not equally expensive. A
wrong `true` strands a run until an operator intervenes. A wrong `false` runs
one run twice.

## Wire the probe

```ts
import { HostLiveness } from "@smthrs/platform-node"

const isAlive = HostLiveness.isAlive({ hostId: "engine-1" })
```

`isAlive` returns a function from an owner to `Effect<boolean>`. The owner type
is structural: `{ hostId: string, pid: number }`, which is exactly the shape of
[`@smthrs/journal`](/api/journal)'s `OwnerId` minus its nonce, so an `OwnerId`
is accepted without this package depending on the journal to name a type.

`@smthrs/flows`' `NodeRuntime` defaults to this function, so a program that
composes the runtime gets it without asking.

## The rule

The rule is asymmetric on purpose:

- **An owner on a different host is alive.** A pid means nothing across
  machines, and the process table this probe reads is only this machine's.
- **An owner on this host is alive exactly while its pid is signalable.** That
  is the same question `ProcessReaper` asks about an abandoned process group,
  and it gets the same answer: a pid that is gone is gone.

Signalable means `process.kill(pid, 0)` did not report `ESRCH`. `EPERM` means
the process exists and belongs to another user, which is still a live owner
this host must not rob. A throw that is not an object at all carries no code,
and reading through it rather than off it is what keeps that from crashing the
probe: a thrown string or `null` is an answer nobody gave, which counts as a
live owner.

## The residual risk

Pid reuse. An owner whose pid was recycled by an unrelated program reads as
alive, and its run waits for an operator.

That is the safe direction. Nothing about a recycled pid can tell this process
whether the run is still being driven, and the cost of guessing wrong the other
way is two hosts executing one run.

## Substitute a better answer where you have one

A multi-process deployment with a supervisor or a lease system knows better
than any pid probe, and should answer from that instead. `isAlive` is one
implementation of a slot, not a fixed policy.

## Know where the sibling disagrees

There is a second shipped implementation of this slot, and it gives the
opposite answer on two inputs. `@smthrs/run-store`'s
`Ownership.sameHostPidProbe` fills the same `LivenessCheck`:

| Input                                              | `HostLiveness.isAlive` | `Ownership.sameHostPidProbe` |
| -------------------------------------------------- | ---------------------- | ---------------------------- |
| an owner on a different `hostId`                   | alive                  | reclaimable                  |
| a signal error that is neither `ESRCH` nor `EPERM` | alive                  | dead                         |

Which answer a deployment gets depends on the entry point it used:
`@smthrs/flows`' `NodeRuntime` defaults to this function, while
[`@smthrs/cli`](/api/cli)'s `NodeControl` passes `sameHostPidProbe`.

There is one more difference. `HostLiveness.isAlive` returns a one-argument
function, which is structurally accepted as an `Ownership.LivenessCheck` and
silently discards the `context` argument the sibling reads.

Reconciling the two is open work, tracked as B-09 in the release support
matrix. Until then, pick the probe deliberately rather than inheriting whichever
one your entry point defaults to.
