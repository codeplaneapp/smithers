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
      reportsDirectory: join(tmpdir(), `flows-memory-coverage-${process.pid}`),
      // Coverage instrumentation only understands source modules. Keeping the
      // SQL migrations in this glob makes v8 ask Rollup to parse them as
      // JavaScript, producing a warning for every migration on every run.
      include: ["src/**/*.ts"],
      thresholds: {
        branches: 65,
        functions: 74,
        lines: 84,
        statements: 83
      }
    }
  }
})
