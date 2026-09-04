---
title: "Cache admission"
description: "The conditions a step result must meet before another run may reuse it, how a hit is verified before it is served, and the ordering that makes a shared tier safe."
sidebar:
  order: 6
---

Serving a recorded result instead of executing a step is the most valuable and
the most dangerous thing this package does. Cache admission is the set of
conditions a result must meet before it becomes reusable, and cache
verification is the check that runs before a recorded result is actually
served.

## What gets admitted

The engine admits a cache record only when all of the following hold:

- The action is `sealed`.
- The boundary is `hard`.
- No deviation occurred.
- The evidence explicitly carries `wholeTreeWritesVerified: true`.

Older evidence, and boundaries that observe declared paths only, are
conservatively refused. Under the production composition the proof comes from
[`WorkspaceSandbox`](./workspace-transactions.md): the body ran in an isolated
workspace, so a write outside the declared set is a map comparison rather than
an inference, and `ActionPersistence` sets the flag itself. When the whole-tree
diff shows a deviation the declared-read scan would have missed, it records that
deviation and withholds the entry instead.

One more distinction decides reach rather than admission. Only a content-key
record has an address another run can reproduce; an ordinal-key record stays
run-local.

## A hit is verified before it is served

A matching key is not sufficient. Before serving, the store calls
`StepBoundary.prepare` and compares the descriptor's declared `readSet` against
the `readSnapshot` the host measured:

- Every declared read still matching means reuse.
- A declared path that is missing, or whose digest differs, refuses the hit,
  journals a `cache-provenance` record with `action: "stale_read_set"`, and
  falls through to a real execution.
- Reads the host reports but the declaration never claimed are ignored: the
  declaration is what the key was computed over.

This is Skyframe's dirty-check invariant. The key alone detects a changed
declaration, never a stale one.

A verified hit then calls `replayOutputs` before returning the stored result.
When that refuses with `MissingArtifact`, the normal first answer for a row
recorded on a machine whose artifacts this one has never seen, the dispatch
hydrates from the shared tier and retries the replay exactly once before
falling through to a real execution. A second failure means the tier cannot
serve it either, and executing is strictly better than looping.

## Publication order across two tiers

A shared tier turns one machine's result into every machine's result, and the
order the two writes happen in is a correctness property, not a preference.

1. `ArtifactSync.publish(digests)` runs first, immediately before the
   transaction that records the cache entry and never inside it. It probes the
   shared tier with `findMissing`, uploads what is missing, and re-probes to
   confirm. A publication that cannot make the artifacts durable fails with
   `ArtifactPublicationFailed`, and the shared entry is withheld.
2. The local cache row and the journal record explaining it commit in one
   `DurableWriter` transaction.
3. `CacheSync.publishEntry(entry)` runs after that transaction, publishing the
   already-durable local entry to the shared step-result tier.

Step 1 before step 2 is Bazel's REAPI ordering constraint: an action result is
uploaded after every blob it refers to, because a result accessed before its
blobs are present cannot be validated. Step 3 after step 2 is why `CacheSync`
is a separate seam from the `CacheStore` tag at all: a `CacheStore` whose `put`
also wrote a shared HTTP tier would put a network round trip inside a write
transaction, blocking every other writer for its duration and rolling the local
row back whenever a shared cache was unreachable.

## Neither publication step can fail a run

Both run after `attempts.finish`, so the result is already durably recorded on
this host. Failing a completed run because an optional accelerator is
unreachable trades a real result for an unavailable one.

A refusal withholds the shared copy, never the local row, and journals a
`cache-provenance` record with `action: "unpublished"` carrying the stage
(`artifacts` or `entry`) and the reason. A missing shared entry is therefore
explainable from the journal rather than inferred from its absence.

## Download policy on the read side

`ArtifactSync.hydrate` establishes that this host can resolve every referenced
artifact. How eagerly it materializes them is `DownloadPolicy`, declared on the
shared tier as `RemoteArtifacts.Options.downloadPolicy` and read from the store
`ArtifactSync.make` was handed, so one deployment setting reaches both seams. An
explicit `downloadPolicy` on `make` or `layer` overrides it.

| Policy          | Behavior on hydrate                                                                                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `all` (default) | Downloads every referenced artifact into this host's store while admitting the replay. Every later read is local, and a shared tier that goes down afterwards costs nothing.                    |
| `toplevel`      | Downloads nothing. One batched `findMissing` establishes that the shared tier can serve what is missing, and `CombinedArtifacts.get` fetches and writes back the blobs a reader actually reads. |
| `minimal`       | The same probe and the same zero downloads; `CombinedArtifacts.get` then serves without writing back, so this host never accumulates other machines' artifacts.                                 |

The two lazy policies are sound only when the store the replay reads through
can reach the shared tier, which means `CombinedArtifacts` with the same remote
tier. Under a purely local `ArtifactStore` an admitted lazy replay would later
read an artifact this host never fetched. A tier that refuses the probe is
indistinguishable from one that holds nothing, so the replay is refused either
way and the step executes.

## When two runs disagree

Two runs that record different results under the same content key mean the
declaration does not fully describe what the step depends on. That is a
hermeticity violation, and it goes to the `Inconsistency` receiver:

- `Inconsistency.layerStrict(owner)` journals the conflict and fails the
  dispatch. This is the default for engine wiring, because a non-hermetic
  sealed hard-boundary action is a defect rather than a condition to paper
  over.
- `Inconsistency.layerTolerant(owner)` journals and continues, preserving the
  first-recorded row. That is Skyframe's tolerant production configuration.
- `Inconsistency.layerNoop()` journals nothing and tolerates everything.

The record goes through the journal's durable channel, so a `tolerate` verdict
that silently dropped its only record cannot wire the detector to nothing.

## Related

- [Step boundaries](./step-boundaries.md): where `wholeTreeWritesVerified`
  comes from.
- [Share a cache across machines](../guides/share-a-cache-across-machines.md):
  the composition that turns this on.
- [Content addressing](/docs/concepts/content-addressing/) on smithers.sh: how
  a step key is built in the first place.
