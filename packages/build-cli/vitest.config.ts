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
      // this flag they were declared and never computed.
      enabled: true,
      provider: "v8",
      reportsDirectory: join(tmpdir(), `flows-build-cli-coverage-${process.pid}`),
      include: ["src/**"],
      // The floors are the measured coverage rounded down, an honest ratchet
      // raised as tests accrete toward the workspace's 100% norm, never
      // lowered. They were set once in 2026-08 and left where they were set,
      // clearing the branch floor by under a point while the uncovered surface
      // sat in the code that spawns processes and writes files.
      thresholds: {
        branches: 76,
        functions: 89,
        lines: 88,
        statements: 86,
        // Per-file floors over the execution backends. Without them a
        // regression in the modules that spawn, capture, and publish hides
        // behind an aggregate dominated by the planner and the renderers,
        // which is exactly where it hid before.
        "src/PackageExec.ts": { statements: 76, branches: 67, functions: 83, lines: 80 },
        "src/PackageLoader.ts": { statements: 80, branches: 65, functions: 86, lines: 83 },
        "src/PackageTree.ts": { statements: 86, branches: 74, functions: 95, lines: 90 },
        "src/ServiceSupervisor.ts": { statements: 87, branches: 80, functions: 84, lines: 88 },
        "src/RepoResolution.ts": { statements: 72, branches: 51, functions: 62, lines: 79 },
        "src/RspackRunner.ts": { statements: 82, branches: 72, functions: 68, lines: 85 },
        "src/DockerExec.ts": { statements: 77, branches: 58, functions: 80, lines: 82 },
        "src/GoExec.ts": { statements: 70, branches: 55, functions: 73, lines: 73 },
        "src/StampExec.ts": { statements: 96, branches: 90, functions: 100, lines: 96 }
      }
    }
  }
})
