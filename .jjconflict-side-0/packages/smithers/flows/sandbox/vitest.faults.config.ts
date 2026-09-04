/**
 * The fault tier: the sandbox-failure cases.
 *
 * The cases here `SIGSTOP` and kill a real sandbox process and read the
 * health the operating system produced. Pids and loopback ports are machine-
 * global, so the tier runs serially.
 *
 * Coverage is off. The work these cases do happens in child processes this one
 * never instruments, and `vitest.config.ts` beside this file stays the coverage
 * gate for `src`.
 */
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/faults/**/*.test.ts"],
    // A fault case drives real processes, real SQLite files, and real sockets.
    // The budget stays finite so a wedged case still fails instead of sitting
    // until the CI job timeout.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // A suite that spawns and kills processes cannot share a worker with
    // another suite doing the same: pids, ports, and process groups are
    // process-global.
    fileParallelism: false,
    coverage: { enabled: false }
  }
})
