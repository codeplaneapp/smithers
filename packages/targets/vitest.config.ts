import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      // Enabled so the thresholds below actually gate every run; without
      // this flag they were declared and never computed. The floors are the
      // measured coverage on 2026-08-15 rounded down one point — an honest
      // ratchet, raised as tests accrete toward the workspace's 100% norm,
      // never lowered.
      enabled: true,
      provider: "v8",
      reportsDirectory: join(tmpdir(), `flows-targets-coverage-${process.pid}`),
      include: ["src/**"],
      thresholds: {
        branches: 88,
        functions: 90,
        lines: 94,
        statements: 93
      }
    }
  }
})
