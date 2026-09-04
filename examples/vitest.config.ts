import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    // A developer's credentials must not turn the ordinary suite into a paid
    // network run. Live smoke tests remain available through explicit opt-in.
    env: process.env.SMITHERS_LIVE_EXAMPLES === "1" ? {} : { OPENAI_API_KEY: "" },
    // Examples drive real SQLite files and real engine restarts, so they are
    // slower than a unit suite. The budget stays finite so a hang still fails.
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
})
