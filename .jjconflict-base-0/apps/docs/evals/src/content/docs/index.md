---
title: "@smthrs/evals"
description: "Fixed-suite evaluation, baselines, regression reports, and score gates for flows"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/evals/docs/README.md"
---

`@smthrs/evals` evaluates flows against a fixed suite. A `Suite` declares named
cases and the scorers bound to grade them. A `Runner` executes every case
through an injected `CaseExecutor` and grades the executions. A `Baseline`
records what a run scored as a committed artifact. `Regression` compares the
next run with that artifact, `Report` renders the comparison as JSON or
Markdown, and `Gate` turns it into a CI exit code.

The package is workspace-private at 1.0.0-rc.0 and is not published to npm. It
is consumed from inside the smithers repository, where `evals/agent` is the
worked suite: it evaluates the Smithers agent offline against a scripted model
and gates the run on a committed baseline.

## A working example

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

`Runner.run` needs only the `CaseExecutor` service: scoring runs in process by
default. The `runId` and `at` values come from the caller, so two runs of the
same suite over the same inputs produce byte-identical observations.

## Where to go next

- [Installation](/installation/) adds the package to a workspace package and lists its entry points.
- [Quickstart](/quickstart/) walks one complete loop: suite, run, baseline, gate.
- How-to guides: [author a suite](/guides/author-a-suite/), [run a suite](/guides/run-a-suite/), [maintain a baseline](/guides/maintain-a-baseline/), [gate a run in CI](/guides/gate-a-run-in-ci/).
- Concepts: [fixed suites](/concepts/fixed-suites/), [step keys and comparison](/concepts/step-keys/), [determinism and canonical artifacts](/concepts/determinism/).
- The [API reference](/reference/api/) documents every export, the failure codes, and the batch protocol.
- [Troubleshooting](/troubleshooting/) maps every failure code to its cause and its fix.

## Maintaining these docs

This directory and the public JSDoc in `src/` own everything published about
`@smthrs/evals`. The package README is a short entry point that links here and
restates nothing. `api.md` is the reference, and `test/docs.test.ts` gates its
export table: the test fails when an export carrying a `@category` tag is
missing from the table, or when the table names an export that no longer
exists. Keep the two in step in the same commit as the source change.
