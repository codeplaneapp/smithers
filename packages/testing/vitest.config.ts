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
      reportsDirectory: join(tmpdir(), `flows-testing-coverage-${process.pid}`),
      include: ["src/**"],
      // The workspace norm is 100% and the release contract's tooling baseline
      // states it. These floors are the measured coverage on 2026-09-01
      // rounded down one point, the same honest ratchet the other packages
      // short of the norm carry: raised as tests accrete, never lowered. What
      // is still uncovered is named in `docs/api.md`: the durable branches of
      // `FlowEngineLike` and `MemoryEngine` that only a real restart boundary
      // reaches, and the pin helpers' exhaustion paths.
      thresholds: {
        branches: 81,
        functions: 95,
        lines: 95,
        statements: 94
      }
    }
  }
})
