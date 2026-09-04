---
title: "@smthrs/engine-store"
description: "The durable FlowEngine: journal-backed run ownership, persisted attempts, hermetic step boundaries, workspace transactions, and the shared step cache, composed into one Effect layer."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/engine-store/docs/README.md"
---

`@smthrs/engine-store` is the durable engine a Smithers run executes on. It
takes the storage packages a workspace already has, the journal, the run store,
the step cache, and the artifact store, and composes them into one `FlowRuntime`
that claims a run before driving it, fences every write against the current
owner, and persists attempts, waits, and terminal results as it goes.

The problem it solves is what happens after a process dies. An in-memory engine
loses the run: the work that already finished is gone, the timer that was
pending never fires, and nothing else can tell whether the owner is still
working or was killed. This package answers all three. A restarted process
replays the attempts that already settled instead of repeating them, a periodic
sweep re-arms the durable clocks and re-drives the runs a dead owner stranded,
and every write is fenced on an `OwnerId`, so a zombie process that comes back
loses its compare-and-swap rather than corrupting the run.

## Who uses this package

Hosts compose it: `EngineStore.layer` is what turns a set of storage layers into
the engine [`@smthrs/flow`](https://flow.smithers.sh/reference/api/) executes against, and it is what
[`@smthrs/flows`](https://flows.smithers.sh/reference/api/)'s `NodeRuntime` builds for the CLI. Workflow
authors do not call it directly; they declare flows and actions, and this
package decides what is persisted, what is replayed, and what is refused.

## Install

```bash
pnpm add @smthrs/engine-store
```

For the storage packages a runnable composition adds, see
[Installation](/installation/).

## The smallest real composition

```ts
import { EngineStore, StepBoundary, WorkspaceSandbox } from "@smthrs/engine-store"
import { Ownership } from "@smthrs/run-store"
import * as Layer from "effect/Layer"

const engine = EngineStore.layer({
  owner: { hostId: "worker-a" },
  journalSource: "worker-a-engine",
  isAlive: Ownership.sameHostPidProbe
}).pipe(
  Layer.provideMerge(Layer.merge(StepBoundary.layer, WorkspaceSandbox.layerFileSystem()))
)
```

`layer` provides `FlowRuntime` and `FlowEngine.SnapshotBoundary`. Everything it
still needs, the journal, the run and attempt stores, the cache store, the
durable engine state, a `Jj`, an `OwnerIdentity`, and a `Crypto`, is an unmet
requirement in the layer's type, so a composition that forgets one fails to
compile rather than at run time. The
[Quickstart](/quickstart/) fills them in and runs a flow twice over one
SQLite file.

## The package at a glance

The root entry point exports each module as a namespace, and each is also
importable from `@smthrs/engine-store/<Module>`.

| Namespace            | What it is                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `EngineStore`        | The durable `FlowRuntime` composition and its options.                                                         |
| `DurableEngineState` | Durable deferreds, clocks, waiting rows, and the run parent DAG.                                               |
| `StepBoundary`       | The declared read and write sets of a step, measured before and after it runs.                                 |
| `WorkspaceSandbox`   | The workspace transaction: a body runs isolated and returns its writes instead of performing them.             |
| `StepSandbox`        | Scope-safe acquisition of one isolated workspace per step.                                                     |
| `PlanScheduler`      | Drives a persisted [`@smthrs/plan`](https://plan.smithers.sh/reference/api/) plan to completion.                                             |
| `Reconciliation`     | Answers a boundary deviation or a landing conflict with a verdict.                                             |
| `Selection`          | The advisory seam that guesses which sink nodes are safe to postpone.                                          |
| `SelectionStore`     | Durable persistence and training for those guesses.                                                            |
| `ArtifactSync`       | Publishes referenced blobs to a shared tier before a cache entry becomes visible, and hydrates them on replay. |
| `CacheSync`          | Publishes a durable local cache entry to a shared step-result tier.                                            |
| `ArtifactGc`         | Explicit mark and sweep collection of unreferenced blobs.                                                      |
| `Retention`          | Explicit deletion of finished run history.                                                                     |
| `RunCatalogRead`     | The workspace's run set, for a [`@smthrs/sync`](https://sync.smithers.sh/reference/api/) follower.                                           |
| `DisasterRecovery`   | Hot backup, verification, restore, and restore-time fencing.                                                   |
| `Inconsistency`      | The receiver for cache conflicts and corrupt evidence.                                                         |
| `OwnerIdentity`      | Mints the `OwnerId` an incarnation fences its writes with.                                                     |
| `WakeBus`            | Edge-triggered in-process wakes, with durable polling as the fallback.                                         |
| `EngineStoreMetrics` | Metric handles and observation combinators for the engine hot paths.                                           |
| `Migrations`         | This package's migration set, and the composed set an engine installs.                                         |
| `RunState`           | The versioned state envelope stored in each run row.                                                           |
| `Errors`             | The stable error contract: every `code` literal is public API.                                                 |
| `test/TestStores`    | Every durable engine service over one migrated database, for tests.                                            |

Every export, with signatures and errors, is on the
[API reference](/reference/api/).

## Where to go next

- [Installation](/installation/): requirements, import forms, and the
  packages a runnable composition adds.
- [Quickstart](/quickstart/): compose a durable engine over SQLite, run a
  flow, restart, and watch the step replay instead of re-executing.
- Concepts: [ownership and fencing](/concepts/ownership-and-fencing/),
  [attempts and replay](/concepts/attempts-and-replay/),
  [step boundaries](/concepts/step-boundaries/),
  [workspace transactions](/concepts/workspace-transactions/),
  [durable waits](/concepts/durable-waits/), and
  [cache admission](/concepts/cache-admission/).
- Guides: [compose a durable engine](/guides/compose-a-durable-engine/),
  [reclaim runs from a dead host](/guides/reclaim-runs-from-a-dead-host/),
  [drive a plan](/guides/drive-a-plan/),
  [share a cache across machines](/guides/share-a-cache-across-machines/),
  [delete old run history](/guides/delete-old-run-history/),
  [collect unreferenced artifacts](/guides/collect-unreferenced-artifacts/),
  [back up and restore the store](/guides/back-up-and-restore/),
  [coordinate two processes](/guides/coordinate-two-processes/),
  [defer work with selection](/guides/defer-work-with-selection/),
  [observe engine metrics](/guides/observe-engine-metrics/), and
  [test against a durable store](/guides/testing/).
- [Troubleshooting](/troubleshooting/): the typed failures this package
  reports, what causes each one, and what to change.
