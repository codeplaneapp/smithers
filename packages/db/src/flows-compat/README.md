# flows storage compat

Stage 1.1 of the flows migration (`.smithers/specs/flows-migration.md`). The
event, run-claim, and attempt-lifecycle paths of `adapter.js` run on the flows
`Journal`, `RunStore`, and `AttemptStore`, behind a module that preserves
`adapter.js`'s call signatures.

Default off. `SMITHERS_FLOWS_STORAGE=1` (or `SMITHERS_ENGINE=flows`) turns it on,
and only on a file-backed bun:sqlite workspace. A PGlite or Postgres workspace
keeps the legacy path: flows ships one SQL backend, which is the stage 0.4
decision.

## Layout

| File | What it is |
| --- | --- |
| `flowsStorageGate.js` | the opt-in and SQLite-only decision |
| `flowsStores.js` | the flows layer stack over the workspace's SQLite file |
| `flowsAdapterCompat.js` | the `adapter.js`-shaped operations |
| `flowsRunSync.js` | the one-shot migration for live runs, and the per-run catch-up |
| `eventTranslation.js` | `_smithers_events` rows to journal producer events, both directions |
| `attemptTranslation.js` | `_smithers_attempts` rows to flows attempts, both directions |
| `runTranslation.js` | Smithers run status and ownership to `flows_runs` |
| `ownerIdentity.js` | `runtime_owner_id` to the flows `OwnerId` fence, both directions |
| `mirrorSql.js` | writes to the legacy tables through the flows connection |
| `vendoredFlows.js` | how the vendored flows packages are reached, and why at runtime |

## Reaching flows

`vendoredFlows.js` resolves `@flows/journal`, `@flows/run-store`, and
`@smthrs/database/DurableWriter` at runtime rather than importing them. Two
measured constraints force that, and both are recorded in that file: a flows edge
in a Bun-visible manifest makes `bun install` fail on the vendored tarballs'
registry-absent versions, and `@smthrs/database` has no `@flows/*` alias at all.
Once the flows alpha publishes, step 1 of `vendor/flows/README.md`'s swap turns
these into ordinary declared imports.

`@effect/sql-sqlite-bun` is the one dependency this lane added to
`packages/db/package.json`. flows' own SQLite layer uses
`@effect/sql-sqlite-node`, which opens `node:sqlite` with `allowExtension`, and
Bun's SQLite is built without extension loading, so it cannot open a database in
the runtime a Smithers SQLite workspace runs on.

## What moved

| `adapter.js` method | flows counterpart |
| --- | --- |
| `insertEventWithNextSeq` | `Journal.emitDurable` inside `Journal.transact` |
| `claimRunForResume` | `RunStore.claimAndOwn` with `LivenessEvidence` |
| `insertAttempt` | `AttemptStore.put` |
| `claimAttemptCompletion`, `claimAttemptTerminal` | `AttemptStore.finish` |
| `heartbeatAttempt` | `RunStore.heartbeat` plus `AttemptStore.heartbeat` |

Every one of them mirrors into the legacy `_smithers_*` row in the same flows
transaction, so `listAttempts`, the event-history queries, the gateway, and the
UI keep reading exactly what they read before. The legacy tables stay the read
model until stage 1.3 moves the readers.

## What deliberately did not move

- **`updateAttempt`.** It writes an arbitrary column patch, which flows does not
  model: flows owns attempt lifecycle, not column patches.
- **Any call made inside a transaction `adapter.js` already opened.** The flows
  stores hold their own connection to the same file, so a flows write nested
  inside a Smithers `BEGIN IMMEDIATE` would wait on the lock its own caller
  holds. `SmithersDb.flowsStorageDelegates()` returns `false` at non-zero
  transaction depth and the legacy path runs.
- **The lease on a parked run.** `flows_runs` forbids an owner on a non-running
  row, so a Smithers run that is `waiting-approval` with a runtime owner maps to
  `suspended` with none. Stage 1.4's waiting taxonomy is what lets a parked run
  keep its owner.
- **Ownership arbitration outside `claimRunForResume`.** `_smithers_runs` remains
  the authority on who owns a run in this stage; `syncRunIntoFlows` reconciles
  `flows_runs` from it in the same transaction as the write it precedes, which is
  what lets the flows fence be evaluated against the ownership the caller holds.

Both of the first two leave the flows tables briefly behind the legacy ones.
`syncRunIntoFlows` is what repairs that: it is idempotent, it runs at the head of
every delegated call, and it copies legacy event rows into
`flows_journal_events` keeping their sequence, so the journal's next allocation
is above them rather than colliding with them.

## Cost

Every delegated call opens a flows write transaction and runs the per-run
catch-up inside it, which is a handful of statements on the flows connection
before the write itself. That is deliberate for a default-off stage: correctness
of the two-table invariant first. The catch-up is the obvious thing to make
cheaper — a per-run watermark held in memory — once stage 1.3 makes the flows
path the one runs actually execute on.

## Stronger than the legacy path, on purpose

`claimRunForResume` refuses to take over a run whose recorded owner is still
live. The legacy predicate accepts a stale heartbeat as sufficient; flows
requires `LivenessEvidence`, and `buildLivenessEvidence` will not fabricate it.

The liveness verdict comes from `runDriverLiveness.js`, not from a second
implementation here, so the compat path inherits the two rules the resume
surfaces already depend on: a PID that started after the run's last heartbeat is
a recycled number and counts as dead, and a cross-host owner is judged by its
heartbeat rather than assumed unreachable. What stays claimable is therefore
exactly what the engine's own precondition treats as ownerless: a dead
same-host process, a recycled PID, and a cross-host owner that stopped
heartbeating.

`--force` and `--steal-ownership` are the deliberate exception. They reach the
adapter as `requireStale: false`, which is the caller stating that it means to
displace a live owner. flows has no path for that — `claimAndOwn` and `steal`
both require the persisted heartbeat to be older than `heartbeatStaleAfter`,
because flows models lease expiry — so the legacy compare-and-set arbitrates and
`reconcileRunOwnership` republishes the row it wrote into `flows_runs` in the
same transaction. The expected-snapshot half of the legacy predicate still
applies, so an override cannot claim a run that changed under it.

Reactivating a terminal run takes the same legacy-arbiter path. `claimAndOwn`
admits `pending`, `suspended`, and `running` only, and Smithers resumes runs that
already finished, failed, or were cancelled — replay, fork, and `retry-task` all
do — which map onto the flows terminal statuses. flows has no lease transition
out of one, so the legacy predicate decides those claims and
`reconcileRunOwnership` republishes the row.

A claim owner id flows cannot fence takes the same path. `runtime_owner_id` is an
opaque string on the Smithers side and not every writer uses the
`pid:<pid>@<host>:<session>` form — `smithers supervise` claims with
`supervisor:<name>`, which names no pid — so there is no `OwnerId` triple to
fence on and `flows_runs` stays owner-less for that run.

## Redaction

The journal redacts credentials on write, by design. `_smithers_events` keeps the
verbatim row it always kept, so a payload carrying a bearer token appears
verbatim in `_smithers_events` and redacted in `flows_journal_events`. That is
the only case where the round trip through `eventTranslation.js` is not exact.
