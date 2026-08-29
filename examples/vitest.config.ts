import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    // Examples drive real SQLite files and real engine restarts, so they are
    // slower than a unit suite. The budget stays finite so a hang still fails.
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
})
