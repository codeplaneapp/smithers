import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    // House convention (see packages/patterns/vitest.config.ts): a finite
    // wall-clock budget so correct suites survive coverage-instrumented load
    // while a genuine hang still fails the run. Scanner tests copy fixture
    // trees and open SQLite databases, so the budget is 60 s rather than 30 s.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Fixtures are byte-for-byte copies of real Smithers 0.x projects. They
    // carry their own `*.test.ts` files, which are inputs to the scanner and
    // must never be collected as this package's tests.
    exclude: ["**/node_modules/**", "**/dist/**", "test/fixtures/**"],
    coverage: {
      enabled: true,
      provider: "v8",
      // Per-process report directory so concurrent vitest runs do not destroy
      // each other's coverage scratch state.
      reportsDirectory: join(tmpdir(), `flows-migrate-coverage-${process.pid}`),
      include: ["src/**"],
      thresholds: {
        branches: 70,
        functions: 70,
        lines: 70,
        statements: 70
      }
    }
  }
})
