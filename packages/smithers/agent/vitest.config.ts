import { tmpdir } from "node:os"
import { join } from "node:path"
import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // The fault tier lives under `test/faults` and runs from
    // `vitest.faults.config.ts` instead, serially and without coverage: its
    // cases kill process groups and bind ports, which no unit suite sharing
    // this machine can survive beside them.
    include: ["test/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "test/faults/**"],
    environment: "node",
    // House convention (see packages/smithers/flows/journal/vitest.config.ts): a finite 30 s
    // wall-clock budget so correct suites survive coverage-instrumented load
    // while a genuine hang still fails the run.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      enabled: true,
      provider: "v8",
      // Per-process report directory so concurrent vitest runs do not destroy
      // each other's coverage scratch state (issues #115/#121).
      reportsDirectory: join(tmpdir(), `flows-agent-coverage-${process.pid}`),
      include: ["src/**"],
      // These directories are packages of their own, nested here because this
      // package is what they are made of. The v8 provider reports every file
      // EXECUTED under this vitest root whatever `include` says, and this
      // package imports them, so their modules would land in this denominator.
      // Each one is already the denominator of its own 100% gate under its own
      // label. Counting them here would measure the same code twice and put
      // this gate permanently out of reach, because the cases that cover them
      // run in those suites. The exclusion removes another package's tree and
      // never this package's own source, which is the distinction
      // `packages/smithers/flows/test/vitestCoverageIsolation.test.ts` enforces.
      exclude: [
        "chain/**",
        "evals/**",
        "fs/**",
        "harness/**",
        "integrations/**",
        "memory/**",
        "model/**",
        "plugin/**",
        "registry/**",
        "scorers/**",
        "std/**",
        "triggers/**"
      ],
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100
      }
    }
  }
})
