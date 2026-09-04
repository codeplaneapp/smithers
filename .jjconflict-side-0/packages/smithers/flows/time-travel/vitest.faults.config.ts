/**
 * The fault tier: the time-travel cases.
 *
 * Every case here drives a real run to completion over a real jj workspace
 * and then reads or rewinds it. The workspace and the database are on disk
 * and the cases share a temporary root, so the tier runs serially.
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
