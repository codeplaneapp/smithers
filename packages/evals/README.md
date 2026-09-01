# @smthrs/evals

Fixed-suite evaluation for flows: it connects target execution and scorer runners
to validated suites, committed baselines, regression comparison, reports, and CI
gates.

The package is workspace-private at 1.0.0-rc.0 and is **not published to npm**.
It is consumed from inside this repository; `evals/agent` is the worked suite.

```ts
import { Flow } from "@smthrs/core"
import { CaseExecutor, Runner, Suite } from "@smthrs/evals"
import { Effect, Layer } from "effect"

const greet = Flow.make({ name: "greet" })

const executor = CaseExecutor.make((suiteCase) =>
  Effect.succeed({
    output: `Hello, ${(suiteCase.input as { readonly name: string }).name}`,
    stepKey: suiteCase.name,
    latencyMs: 0,
    target: greet
  })
)

const program = Effect.gen(function*() {
  const suite = yield* Suite.make({
    name: "smoke",
    cases: [{ name: "hello", input: { name: "Ada" } }],
    concurrency: 1
  })
  return yield* Runner.run(suite, { runId: "nightly-2026-01-01", at: "2026-01-01T00:00:00.000Z" })
}).pipe(Effect.provide(Layer.succeed(CaseExecutor.CaseExecutor)(executor)))
```

`Runner.run` needs only `CaseExecutor`: scoring runs in process by default.

## Documentation

`docs/api.md` is the reference, and the JSDoc in `src/` is its source. Read it
for the pipeline, the step-key rule that decides a regression from
nondeterminism, the stable failure codes, the batch-runner protocol, and the
declared size and concurrency limits.

## Development

```sh
pnpm --filter @smthrs/evals test     # vitest, 100% coverage thresholds
pnpm --filter @smthrs/evals check    # tsc over src and test
pnpm --filter @smthrs/evals lint     # eslint + dprint
```
