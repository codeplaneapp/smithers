import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    // House convention (see packages/journal/vitest.config.ts): a finite 30 s
    // wall-clock budget so correct suites survive coverage-instrumented load
    // while a genuine hang still fails the run.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      enabled: true,
      provider: "v8",
      // Per-process report directory so concurrent vitest runs do not destroy
      // each other's coverage scratch state (issues #115/#121).
      reportsDirectory: join(tmpdir(), `flows-patterns-coverage-${process.pid}`),
      include: ["src/**"],
      // The release contract (docs/migration/rc-contract.md section 9) asks for
      // 100 on all four. This package cannot reach it from inside its own
      // dependency closure, and these numbers are the measured floor rather
      // than a chosen allowance: raise them whenever a run measures higher.
      //
      // What is left uncovered is one class of code. A pattern's `make` builds
      // a `@smthrs/core` node tree, and core plans that tree by evaluating
      // `Node.andThen` builders ONCE against a symbolic value. Two consequences
      // follow, and every remaining gap is one of them:
      //
      //   1. A `Node.map` continuation is stored in the AST and never called at
      //      plan time. Only an executing engine calls it. That is every
      //      uncovered function: the batch `merge` helpers in `CheckSuite`,
      //      `Kanban`, `MergeQueue` and `Supervisor`, the shard-ordering maps in
      //      `MapReduce`, `ScanFixVerify` and `Trellis`, and the settle arms in
      //      `Bounded`, `Debate`, `DriftDetector`, `Sidecar` and
      //      `TryCatchFinally`.
      //   2. A conditional on the symbolic value plans one arm only, so the
      //      other is unreachable at build time: `DelegationChain` line 308,
      //      `Escalation` 191 and 198, `Loop` 174, `ReviewLoop` 102 and
      //      `Supervisor` 182.
      //
      // `@smthrs/patterns` depends on `@smthrs/core` and `effect` alone, and
      // core ships no evaluator, so nothing in this package's test scope can
      // run a built graph. Reaching 100 needs either an evaluator these tests
      // may depend on, or those continuations lifted into named functions with
      // a public seam. Both are changes outside this package.
      thresholds: {
        branches: 99,
        functions: 94,
        lines: 98,
        statements: 98
      }
    }
  }
})
