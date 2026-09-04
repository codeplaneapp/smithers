---
title: "Keyed replay"
description: "Every settled call carries a four-part key, and resume replays the settled prefix by that key with zero effects."
sidebar:
  order: 2
---

A resume never re-executes what already settled. It replays the settled
prefix of the current link by ordinal, with zero effects, and then runs live.
The `CallKey` is what makes that safe.

## The four components

Every `CallSettled` event is keyed by four components:

```ts
interface CallKey {
  readonly link: number
  readonly scriptDigest: string
  readonly ordinal: number
  readonly entryDigest: string
}
```

- `link`: the link's index in its chain, counted from zero.
- `scriptDigest`: the digest of the script that issued the call. Calls the
  harness itself issues (bootstrap and recovery author calls) belong to no
  authored script and record `CallKey.harnessDigest`, the empty string.
- `ordinal`: the call's position within its link, counted from zero in issue
  order.
- `entryDigest`: the digest of the called entry's declaration.

A script's digest is always the digest of its text. `Outcome.to` re-derives
it and discards whatever the caller passed, because scripts are
model-authored: a script chooses the text it hands on, never the replay
identity that text is keyed by. Editing one character of a script therefore
re-keys exactly the calls inside it and nothing else.

## What resume checks

Replaying a settled call is not a blind cache read. Before serving the
journaled result, the chain verifies that the live call matches the journaled
one on link and script digest, on the entry name, and on the payload
(compared as canonical JSON). It also re-digests the entry's CURRENT
declaration and compares that to the journaled `entryDigest`: a settled
result is served only under the same declaration it was produced under. Any
mismatch fails the run with `replay_divergence` rather than serving a stale
result.

That declaration rule is what makes reconfiguration loud. `Catalog.make`
digests an entry's name, description, and declared capabilities by default,
so narrowing a claim re-keys the calls settled under the old claim. Richer
catalogs pin more: `RegistryCatalog` digests the flow's full declaration,
`MemoryEntries` digests the memory package's shipped schemas, and
`SubChains` digests the child budgets, prefix, and depth bound. A
memory-package upgrade or a redeclared flow re-keys every call that names it
instead of replaying stale results.

## What replays differently

Three journaled shapes resume in three different ways:

- A `CallSettled` replays as a result with zero effects. The handler does
  not run again.
- A `GateRejected` replays as an abort at the same ordinal, so a resumed
  link never re-executes a rejected call; the link falls through to recovery
  authoring with the recorded observation.
- An approval park journals NOTHING for the parked call. Resuming
  re-executes the link from its settled prefix and re-asks the
  authorization seam under whatever grant now exists. The check stays out of
  the journal on purpose: a permission requirement must be re-decidable
  against a later grant.

The author seat's shape gate is the one place a rejection and a settlement
share an ordinal: the `GateRejected` is journaled first and the raw reply is
then settled as a marker, so a crash between the two resumes through the
rejection rather than replaying the marker as a script.

For the procedure of seeding and resuming a journal, see
[Resume and replay](../guides/resume-and-replay.md). For the divergence
failures, see [Troubleshooting](../troubleshooting.md).
