# @smthrs/testing

This package declares `effect` as an exact
`4.0.0-rc.108` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://testing.smithers.sh

Testing and conformance library for flows. It provides layered engine and model
doubles, pure plan and journal assertions, restart and parity suites, Vitest
adapters, and deterministic score gates.

```sh
npm install --save-dev @smthrs/testing
```

`vitest` and `@effect/vitest` are optional peers, needed only by the `Vitest`
adapter. Everything else runs under any runner, because an assertion is an
ordinary `Effect` and a conformance case is a plain value.

## What is in it

The package under test supplies the deterministic services a run needs:
`@smthrs/kernel` ships `TestHost`, `@smthrs/journal` ships `TestJournal`. This
package supplies what a test then says about the run those services produced,
and the doubles the run executes against.

- **Assertions** over the artifacts a flow produces: `PlanAssertions` for a
  built plan, `JournalAssertions` for a journal, `Divergence` for the first
  attributable difference between two journals, `ScoreGate` for graded eval
  suites.
- **Layer bundles** that make a tier explicit: `TestLayers.unit` for the unit
  tier, `TestLayers.poisoned` for plan-time purity.
- **Conformance suites** an implementation must pass: `Conformance.coreSuite`
  for any engine, `HostSuite.hostSuite` for any Host bundle.
- **Doubles**: `MemoryEngine` and `RestartableEngine` as reference engines,
  `FlowEngineLike` as the adapter that runs the same pins against the real
  engine, and `RecordedModel`, `RecordingModel`, and `CachedModel` as the
  record-and-replay model loop.

Every module, every export, and the contract of each is at
<https://testing.smithers.sh/reference/api/>.

## Certify an engine in fifteen lines

```ts
import { Conformance, EngineSubject, FlowEngineLike } from "@smthrs/testing"
import { describe, it } from "@smthrs/testing/Vitest"
import * as Effect from "effect/Effect"

const subject = FlowEngineLike.layerMemory

describe("engine conformance", () => {
  for (const conformanceCase of Conformance.coreSuite()) {
    it.scoped(conformanceCase.name, () =>
      Effect.flatMap(EngineSubject.EngineSubject, conformanceCase.run).pipe(
        Effect.provide(subject)
      ))
  }
})
```

Nine black-box pins run: identity, interruption, replay, and race. The race and
interrupt cases advance a `TestClock`, which is why they are registered through
`it.scoped` rather than `it.live`.

## Record, then replay

A model test runs the same code twice. The first run has no fixture, so it
calls the provider and writes what came back. Every run after it reads that file
and never touches the network. `CachedModel` is both halves.

```ts
import { CachedModel, FixtureStore } from "@smthrs/testing"
import { Effect, Layer } from "effect"
import { fileURLToPath } from "node:url"

const fixture = fileURLToPath(new URL("./fixtures/balance.json", import.meta.url))

const modelLayer = Layer.unwrap(
  Effect.map(FixtureStore.makeFile(fixture), (store) => CachedModel.layer({ live: liveModel(), fixture: store }))
)
```

The package reads no environment variable, so how a suite decides to record
stays the suite's business. Two rules the recorder follows, because a fixture is
executable state: an interrupted or dead call is not recorded, because a
truncated stream would replay as an aborted turn; and a call the kernel refused
is not recorded either, because the provider never saw it.

`RecordedModel` is the strict double instead: it claims each recorded call once,
matches by request shape with `modelId` erased, and dies on a request the
fixture does not describe.

## Two modules stay off the root barrel

The root entry point exports one namespace per module, and each is also
importable from `@smthrs/testing/<Module>`. Two are reachable only by subpath.

`Vitest` is ESM only. `vitest` refuses to load through `require()`, so a barrel
that carried it would break `require("@smthrs/testing")` for every CommonJS
consumer of the assertion helpers.

`Faults` is not a double: it is a set of real, machine-global fault primitives.
`killProcess` sends a real signal to a real pid and waits for the operating
system to reap it, `parentPid` and `waitForReparent` read the orphan a kill
leaves behind, and `skewClock` moves the wall clock a durable timer is measured
against. Every package's fault tier imports one implementation from
`@smthrs/testing/Faults`, so "the process is really gone" means the same thing
in all of them.

```ts
import { isAlive, killProcess, waitForReparent } from "@smthrs/testing/Faults"

await killProcess(engine.process)
const reparented = await waitForReparent(orphan, engine.process.pid!)
```

A suite that uses `Faults` to kill somebody else's engine belongs in that
package's `test/faults` tree, behind a `Smithers.FaultSuite` target and a
`vitest.faults.config.ts` with `fileParallelism: false`.

`@smthrs/testing/package.json` is also exported. `internal/*` and nested
`*/index` subpaths are not public.
