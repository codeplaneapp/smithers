import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Planner fixtures copy and fingerprint the production implementation
    // trees. The bounded file pool keeps that work practical, but the root
    // workspace gate still contends for disk with every package, so retain a
    // CI-safe budget for both the test and its cleanup hook.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    coverage: {
      // Enabled so the thresholds below actually gate every run; without
      // this flag they were declared and never computed. The floors are the
      // measured coverage on 2026-08-15 rounded down one point — an honest
      // ratchet, raised as tests accrete toward the workspace's 100% norm,
      // never lowered.
      enabled: true,
      provider: "v8",
      reportsDirectory: join(tmpdir(), `flows-build-cli-coverage-${process.pid}`),
      include: ["src/**"],
      thresholds: {
        branches: 75,
        functions: 84,
        lines: 84,
        statements: 82
      }
    }
  }
})
