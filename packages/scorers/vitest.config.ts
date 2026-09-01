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
      reportsDirectory: join(tmpdir(), `flows-scorers-coverage-${process.pid}`),
      include: ["src/**"],
      // The measured coverage of `src/**` is 100 in all four categories.
      // `branches` is pinned one below only because
      // `packages/flows/test/vitestCoverageIsolation.test.ts` still lists
      // `scorers` in its `coverageFloorDeferred` set and asserts every member
      // keeps at least one threshold under 100. Remove that entry and raise
      // this to 100 in the same commit; the two changes are one edit.
      thresholds: {
        branches: 99,
        functions: 100,
        lines: 100,
        statements: 100
      }
    }
  }
})
