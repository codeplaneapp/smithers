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
      reportsDirectory: join(tmpdir(), `flows-integrations-coverage-${process.pid}`),
      include: ["src/**"],
      // Ratcheted to what the default gate reaches, in the shape
      // `packages/triggers` and `packages/scorers` use. The shortfall is
      // provider behavior a fixture server cannot produce honestly: a real
      // `fetch` transport failure mid-body, a SQLite write that fails after
      // its migration ran, and the unreachable tail of the Linear retry loop.
      // The live suites in `test/*Live.test.ts` cover the provider side of
      // that when a credential is present. Raise these when a case closes;
      // never lower them. Last raised when the durable actions and their
      // conversion tests landed (round 1).
      thresholds: {
        branches: 94,
        functions: 98,
        lines: 99,
        statements: 98
      }
    }
  }
})
