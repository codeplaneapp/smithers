# Cross-engine parity harness

Stage 0.5 of the flows migration
([`.smithers/specs/flows-migration.md`](../../.smithers/specs/flows-migration.md)).

A fixture set of workflows runs on a selectable engine against a real on-disk
database. After each run settles, the durable state it left behind is read back
out of storage, normalized, and compared against a committed oracle: node
states, attempt traces, output rows, the event projection, and the terminal
verdict.

This suite is the objective gate for every later lane. No lane in stages 1 to 3
is accepted while it is red.

## Running

```sh
bun test e2e/parity                 # from the repo root
pnpm -C e2e test:parity             # same suite, from the e2e package
pnpm -C e2e typecheck
```

`SMITHERS_PARITY_ENGINES=legacy,flows` selects engines explicitly. With it
unset, every engine that reports itself available runs. Naming an engine
explicitly makes its unavailability a hard error rather than a skip, so a CI
job that means to exercise the flows engine cannot pass by silently running
only the legacy one.

## Layout

| Path | What it is |
| --- | --- |
| `fixtures/` | One file per fixture: a workflow plus how it is driven. |
| `engines/` | The engine selector. `legacyEngine.ts` runs today; `flowsEngine.ts` is the stage 1.3 seam. |
| `observation/` | Reads durable state back out of the database and normalizes it. |
| `oracles/` | The committed reference observation, one JSON file per fixture. |
| `fault-coverage.json` | How every `../fault-matrix.json` case is accounted for. |
| `parityChildRunner.ts` | Standalone engine child for the crash/resume fixtures. |
| `recordOracles.ts` | Records the oracles on the legacy engine. |

## The oracle

The oracle is recorded on the **legacy** engine and committed:

```sh
bun e2e/parity/recordOracles.ts                    # every fixture
bun e2e/parity/recordOracles.ts crash-resume       # one fixture
```

From then on the file, not the legacy engine, is the reference. A legacy change
that alters durable behaviour shows up as an oracle diff, and from stage 1.3 on
the flows engine is compared against the same file. That is what lets the suite
keep gating after the legacy loop is deleted in stage 1.7.

Re-record only when a behaviour change is intended, and review the diff. The
recorder always uses the legacy engine on purpose: re-recording from a
candidate engine would make the suite tautological.

## What is compared, and what is not

The observation is read with a fresh connection to the on-disk database after
the run settles, so it describes what survived to storage rather than what an
engine reported in memory. Everything volatile is normalized out:

- **Time, paths, process identity, content hashes** never appear.
- **Cross-node event ordering** is not compared. A `<Parallel>` interleaves
  differently on every run. Order is kept within the run scope and within each
  `nodeId::iteration`; cross-node volume is compared as type counts.
- **Engine-internal events** are excluded by an explicit list in
  `observation/eventTaxonomy.ts` — the legacy render loop's `FrameCommitted`
  and `SnapshotCaptured`, scheduler backpressure telemetry, and per-attempt
  agent, tool, and sandbox streams.
- **Error text** is reduced to the error code and the failing node id.
- **Unreproducible output columns** (an approval's `decided_at`) are redacted
  per fixture, so the row's presence and its other columns still gate.

An event type in neither taxonomy list is projected as `unclassified:<type>`
rather than dropped, so a new event type surfaces as an oracle diff and has to
be classified on purpose.

## Adding a fixture

1. Write it under `fixtures/` and export it from `fixtures/index.ts`.
2. Record its oracle. The suite fails on a fixture with no committed oracle.
3. If it carries an `e2e/faults` case, list the case in the fixture's
   `portsFaultCases` and mark it `ported` in `fault-coverage.json`. The
   coverage test enforces that the two agree in both directions.

Crash/resume fixtures run in a real child process that is SIGKILLed for real.
Declare `execution: "crash-resume"` and either `killAfterMarker` (a file the
fixture body writes) or `killWhen` (a predicate over durable state, used by the
restart-while-waiting fixtures). A `drive` on a crash/resume fixture runs
between the kill and the resume, which is the real sequence when an operator
decides a gate on a run whose engine has died.

## Determinism

The suite gates other lanes, so a flaky result here is as expensive as a wrong
one. Two rules keep the crash fixtures deterministic:

- **A `killWhen` resolves on a DURABLY PARKED RUN, never on a parked node.**
  The engine parks in several writes — node state, then the run row and its
  `RunStatusChanged` event. A kill landing between them leaves a half-written
  park that replays a different event sequence on resume, which diffs against
  the fixture's own oracle at random. `waitForParkedApprovalRun` in
  `fixtures/waitingApproval.ts` is the worked example.
- **A parked run may end its own child before the kill lands.** Parking
  releases the run, so the child can finish and exit while the harness is still
  polling. The harness accepts that for `killWhen` fixtures after re-checking
  the durable state: killed or self-exited, the run is ownerless and parked and
  the observation is identical. For `killAfterMarker` fixtures a child exit is
  still a hard error, because there the kill is the fault.

Second connections to a database a child is still bootstrapping fail
transiently with `SQLITE_BUSY*` or `SQLITE_CANTOPEN`. `waitForSchema` polls
through those and only reports the last one if the bootstrap deadline passes.

Before changing anything in the crash/park path, run that subset in a loop
rather than once:

```sh
cd e2e
for i in $(seq 1 25); do
  bun test parity/parity.test.ts -t "restart-waiting-approval|crash-resume|waiting-approval-granted|waiting-event|waiting-timer" || echo "FAIL $i"
done
```

## CI

`pnpm -C e2e test:parity` is not yet wired into a `.github/workflows` job, so
nothing in CI reports this gate red today. Wiring it up is outside the `e2e/`
scope this suite was added under; it needs a step that runs `pnpm -C e2e
typecheck` and `pnpm -C e2e test:parity` after `pnpm install`.

## Fault-case coverage

`fault-coverage.json` classifies every case in `../fault-matrix.json` as either
`ported` (with the fixtures that carry it) or `out-of-scope` (with the reason).
`faultCoverage.test.ts` fails when a matrix case is missing, when a case names
a fixture that does not exist, or when a fixture and the map disagree. A new
fault case therefore cannot land without a decision about whether the parity
suite covers it.

The out-of-scope cases are, in summary: gateway and WebSocket transport,
sandbox and secrets, VCS, cron and webhook ingress, browser runtime, the
nightly soak budgets, and the cases that assert adapter behaviour over rows
seeded directly through `SmithersDb` rather than running a workflow.

## Adding the flows engine (stage 1.3)

Replace `unavailableReason` and `execute` in `engines/flowsEngine.ts`. Every
fixture, oracle, and assertion in the suite carries over untouched, and the
per-fixture "every selected engine produced the same observation" test becomes
load-bearing.
