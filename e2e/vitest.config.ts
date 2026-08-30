import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["faults/**/*.test.ts", "harness/**/*.test.ts", "ci/**/*.test.ts"],
    // Every fault case drives real processes, real SQLite files, and real
    // sockets. The budget stays finite so a wedged case still fails instead of
    // sitting until the CI job timeout.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // A suite that spawns and kills engines cannot share a worker with another
    // suite doing the same: pids, ports, and process groups are process-global.
    fileParallelism: false
  }
})
