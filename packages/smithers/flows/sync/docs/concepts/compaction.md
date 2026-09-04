---
title: "Compaction and resync"
description: "What a compacted refusal means, how the client resumes from the checkpoint the server names, and why the entries below that checkpoint are a real hole the consumer must fill."
---

Compaction deletes a run's journal entries below a checkpoint. A cursor under
that floor names history that no longer exists, so the read cannot be served
and cannot be served later either.

`@smthrs/journal` owns the mechanism, including when a checkpoint is written
and what it may summarize; see
[Checkpoints and compaction](/pkg/journal/concepts/compaction). This page is
about what the sync boundary does with it.

## The refusal names where to resume

The server maps the journal's compacted failure onto its own `compacted` code
and attaches a `Resync` of `{ runId, checkpointSeq }`. `checkpointSeq` is the
compaction floor: the checkpoint's state subsumes every entry at or below it,
so a follower resumes by setting that run's cursor to `checkpointSeq` and
reading forward.

`compacted` is its own code rather than an `unknown` because it is the one
recoverable failure here. Folding it into `unknown` cost the checkpoint, and
with it every path back: the client retries only `transport_failed`, so the
subscription died and every resubscribe from the same cursors died identically.
A whole-workspace subscription then died over a single compacted run.

The run id comes from the call site rather than from the journal error. The
journal error carries only a sequence, and a workspace read fans out over many
runs, so without the id a follower could not tell which cursor to move.

`Resync` rides on `SyncError` as one optional field rather than as a new frame
variant or a new procedure. A follower that never meets a compacted run sees no
change at all, and a later revision can add the checkpoint state without moving
anything that already exists.

## The client recovers, it does not surface

`SyncClient.subscribe` handles `compacted` rather than failing. It runs the
`onResync` hook, moves that run's cursor to `checkpointSeq`, and restarts the
subscription. One compacted run therefore costs one reconnect instead of the
whole subscription.

Two cases stay failures on purpose:

- A `compacted` error carrying no `Resync` has no resume point to apply.
- A checkpoint at or below what the subscription already covers cannot move the
  cursor forward, so retrying would re-read the same refusal forever. That is
  the same non-convergence rule that refuses an incomplete catch-up page which
  makes no progress.

## The hole is real

:::warning
The resync moves a cursor, not state. The entries below `checkpointSeq` are
gone from the journal, and this wire carries no checkpoint state to stand in
for them, so a consumer rebuilding a projection is missing that prefix.
:::

`SubscribeOptions.onResync` is the seam a consumer fills the hole through. It
runs **before** the cursor moves and must succeed. A failure leaves the cursor
where it was and fails the subscription, so nothing is skipped behind the
consumer's back.

What a consumer does there depends on what it is holding:

- A Node follower reads the prefix out of band with
  `journal.latestCheckpoint(runId)` and applies `checkpoint.state`, then
  continues from the sync stream.
- A follower with no derived state has nothing to restore. The default hook
  logs the skipped range and continues, which is the right answer for it.
- A follower that cannot restore the prefix and cannot proceed without it fails
  the hook, and the subscription fails with the cursor unmoved.

[Handle a compacted run](../guides/handle-a-compacted-run.md) is the
task-shaped version, with the hook written out.

## Compaction is opt-in

Without a compaction policy on the journal layer, no entry is ever deleted and
no follower ever meets this code. That is the default. The code path matters
anyway, because the day a workspace enables compaction is the day the
difference between a follower that catches up and one that never can becomes
visible, and by then the follower is already deployed.

## Related pages

- [Checkpoints and compaction](/pkg/journal/concepts/compaction) in
  `@smthrs/journal`: what a checkpoint is and how a floor advances.
- [Scopes and cursors](./scopes-and-cursors.md): what the cursor being moved
  means.
- [Troubleshooting](../troubleshooting.md): the `compacted` symptom and what to
  change.
