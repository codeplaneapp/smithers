import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Only this package's own suites. `template/` holds whole apps, tests
    // included, and those run against the scaffolded copy's node_modules
    // rather than this package's.
    include: ["test/**/*.test.ts"],
    environment: "node",
    // The router and scaffolding suites build throwaway app trees on disk and
    // the cached-model suite runs a flow through QuickJS, so the budget is the
    // same finite 30 s every package uses: generous enough for a loaded CI
    // runner under coverage instrumentation, still finite so a genuine hang
    // fails the gate instead of hanging it.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      // Enabled so the thresholds below actually gate every run; without
      // this flag they were declared and never computed. The floors are the
      // measured coverage on 2026-08-26 rounded down one point — an honest
      // ratchet, raised as tests accrete toward the workspace's 100% norm,
      // never lowered.
      enabled: true,
      provider: "v8",
      // Scope the report directory — and the `.tmp` scratch dir the v8
      // provider clears at run start and reads at run end — to this process.
      // The default `./coverage` is shared, so two concurrent `vitest run`
      // invocations destroy each other (issues #115/#121).
      reportsDirectory: join(tmpdir(), `flows-create-app-coverage-${process.pid}`),
      include: ["src/**"],
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100
      }
    }
  }
})
