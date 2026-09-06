import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    // Like platform-node, these contracts exercise real filesystem operations,
    // child processes, jj, and loopback HTTP. The macOS runner exceeded
    // Vitest's 5 s default in the filesystem contract; retain the same finite
    // 30 s test and cleanup budgets used by the Node host suite.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      enabled: true,
      provider: "v8",
      reportsDirectory: join(tmpdir(), `flows-platform-bun-coverage-${process.pid}`),
      include: ["src/**/*.ts"].map((pattern) => join(import.meta.dirname, pattern)),
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 }
    }
  }
})
