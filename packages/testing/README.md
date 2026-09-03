# @smthrs/testing

Testing and conformance library for flows. It provides layered engine and model doubles, pure plan and journal assertions, restart and parity suites, Vitest adapters, and deterministic score gates.

```sh
npm install @smthrs/testing
```

## Public API

The generated reference is the site's [`/api/testing`](../../docs/pages/api/testing.md)
page: every module, every documented export, and the contract of each, derived
from the source JSDoc so it cannot drift. The table that used to sit here was
hand-maintained and had already drifted -- it advertised a `Vitest` surface on
the root barrel that the barrel deliberately omits.

The root entry point exports one namespace per module, and each is also
importable from `@smthrs/testing/<Module>`. `Vitest` is the exception: it is
ESM-only and absent from the barrel, because `vitest` refuses to load through
`require()` and a barrel that carried it would break `require("@smthrs/testing")`
for every CommonJS consumer of the assertion helpers.

```ts
import { Conformance, EngineSubject, TestLayers } from "@smthrs/testing"
import * as Vitest from "@smthrs/testing/Vitest"
import { Effect } from "effect"

const test = Vitest.testEffect(TestLayers.unit(engineLayer))
for (const testCase of Conformance.coreSuite()) {
  // `.effect` supplies the deterministic clock the race and interrupt pins
  // advance; `.live` does not.
  test.effect(testCase.name, () => Effect.flatMap(EngineSubject.EngineSubject, testCase.run))
}
```

`Faults` is the second module outside the barrel, and for a different reason:
it is not a double but a set of real, machine-global fault primitives —
`killProcess` sends a real signal to a real pid and waits for the operating
system to reap it, `parentPid` and `waitForReparent` read the orphan a kill
leaves behind, and `skewClock` moves the wall clock a durable timer is measured
against. Every package's fault tier imports one implementation of them from
`@smthrs/testing/Faults`, so "the process is really gone" means the same thing
in all of them. A suite that uses it to
kill somebody else's engine belongs in that package's `test/faults` tree,
behind a `Smithers.FaultSuite` target and a `vitest.faults.config.ts` with
`fileParallelism: false`. This module's own suite is the exception and stays in
`test/`: it only signals pids it spawned itself, so it reaches no neighbour, and
staying there is what keeps `src/Faults.ts` inside the package's 100% coverage
denominator.

```ts
import { isAlive, killProcess, waitForReparent } from "@smthrs/testing/Faults"

await killProcess(engine.process)
const reparented = await waitForReparent(orphan, engine.process.pid!)
```

`@smthrs/testing/package.json` is also exported. `internal/*` and nested
`*/index` subpaths are not public.

`docs/api.md` states the contracts a caller depends on -- typed failures and
their stable codes, what is copied and what is aliased, the encoding and
identity rules, and every documented limit -- and `docs/concepts.md` records the
designs the source JSDoc cites. Both are reproduced in the generated reference.

## Record, then replay

A model test runs the same code twice. The first run has no fixture, so it calls the provider and writes what came back. Every run after it reads that file and never touches the network. `CachedModel` is both halves: a request whose canonical digest is already in the fixture replays from it, and a request that is not runs against the live model and is appended.

```ts
import { CachedModel, FixtureStore } from "@smthrs/testing"
import { Effect, Layer } from "effect"
import { fileURLToPath } from "node:url"

const fixture = fileURLToPath(new URL("./fixtures/balance.json", import.meta.url))

const modelLayer = Layer.unwrap(
  Effect.map(FixtureStore.makeFile(fixture), (store) => CachedModel.layer({ live: liveModel(), fixture: store }))
)
```

Run 1 records:

```sh
pnpm vitest run test/balance.test.ts   # fixtures/balance.json does not exist yet
git add test/fixtures/balance.json
```

Run 2 and every run after it replay:

```sh
pnpm vitest run test/balance.test.ts   # no API key, no network
```

The package exposes the layers and nothing else. `CachedModel` records whatever the fixture is missing, so how a consumer decides to record is the consumer's business: an environment flag such as `SMTHRS_RECORD=1` that swaps `live` for a model with no credentials, a separate `test:record` script, or deleting the fixture file and re-running. The package has no opinion and reads no environment.

Two rules the recorder follows, because a fixture is executable state:

- A call that is interrupted, or that dies, is not recorded. A truncated stream has no `settle` event and would replay as an aborted turn.
- A call the kernel refused (`PermissionRequired`, `PermissionDenied`, `GrantStoreError`) is not recorded either. The provider never saw it, so there is no exchange to record; the failure still reaches the caller.

`RecordingModel` is the recorder on its own, for a test that wants the calls in memory rather than in a cache:

```ts
import { RecordingModel } from "@smthrs/testing"
import { Ref } from "effect"

const recorded = yield* Ref.make<ReadonlyArray<Fixture.RecordedCall>>([])
const model = RecordingModel.make(liveModel(), (call) => Ref.update(recorded, (calls) => [...calls, call]))
```

`RecordedModel` is the strict replay double: it claims each fixture call once, matches by request shape with `modelId` erased, and dies on a request the fixture does not describe. Use it when a test must assert that exactly the recorded calls happened. Use `CachedModel` when a test only needs the calls to be free and deterministic.
