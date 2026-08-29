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
      reportsDirectory: join(tmpdir(), `flows-cli-coverage-${process.pid}`),
      include: ["src/**"],
      // Ratcheted to the measured surface after the Phase 4 port, with a few
      // points of headroom for the checks whose branches depend on the host
      // (`jj` on PATH, provider keys exported). Lower these only with a
      // reason; the point of the ratchet is that deleted coverage fails.
      thresholds: {
        branches: 76,
        functions: 72,
        lines: 79,
        statements: 78
      }
    }
  }
})
