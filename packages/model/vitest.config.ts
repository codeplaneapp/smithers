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
      reportsDirectory: join(tmpdir(), `flows-model-coverage-${process.pid}`),
      include: ["src/**"],
      // The rc.0 contract asks for 100% here. These are the honest measured
      // floors, ratcheted up from 75/92/93/90 once the Chat Completions state
      // machine, the executor's classification and redaction paths, and the
      // route's preparation failures were actually covered. The remainder is a
      // handful of defensive branches, and closing it is what removes "model"
      // from `coverageFloorDeferred` in
      // packages/flows/test/vitestCoverageIsolation.test.ts, which today
      // requires at least one threshold below 100 for the packages it lists.
      thresholds: {
        branches: 98,
        functions: 99,
        lines: 100,
        statements: 99
      }
    }
  }
})
