import { defineConfig } from "vitest/config"

// Two suites, one runner:
// - `flows/**/*.e2e.ts` replays a recorded model fixture per flow.
// - `test/**/*.test.ts` covers the wire contract in src/.
//
// The vite.config.ts plugins are deliberately absent: nothing under test needs
// workerd, and the create-app plugin would regenerate routes.gen.ts on every
// run. Regeneration is `pnpm routes`.
export default defineConfig({
  plugins: [{
    name: "bootstrap-test-imports",
    // The bootstrap suite mocks rendering; no app/Vite plugins run in tests.
    resolveId(id) {
      if (id === "virtual:smthrs-app/brand.css") return id
    }
  }],
  test: {
    include: ["flows/**/*.e2e.ts", "test/**/*.test.ts"],
    environment: "node",
    // A recording run (`pnpm test:record`) makes real provider calls.
    testTimeout: 300000
  },
  resolve: {
    // Linked @smthrs/* packages carry their own node_modules. One `effect`
    // instance per run keeps Context tags identical across them.
    dedupe: ["effect"]
  }
})
