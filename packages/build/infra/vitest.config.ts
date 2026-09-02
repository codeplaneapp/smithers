import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["worker/test/**/*.test.ts", "scripts/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      // Enabled so the thresholds below are computed rather than declared:
      // `Smithers.Vitest` only declines to pass `--coverage.enabled=false`,
      // and vitest's own default is off, so nothing measured this package
      // until this block existed. The floors are the measured coverage
      // rounded down: an honest ratchet, raised as tests accrete toward the
      // workspace's 100% norm, never lowered.
      enabled: true,
      provider: "v8",
      reportsDirectory: join(tmpdir(), `flows-build-infra-coverage-${process.pid}`),
      include: ["worker/**/*.ts", "scripts/**/*.ts", "deployment.ts"],
      // `alchemy.run.ts` is the Cloudflare resource graph. It cannot execute
      // without an account, so every rule it could encode lives in
      // `deployment.ts` instead, and `worker/test/deployment-config.test.ts`
      // gates the wiring that remains by reading the file.
      exclude: ["worker/test/**", "scripts/**/*.test.ts", "alchemy.run.ts"],
      thresholds: {
        branches: 86,
        functions: 97,
        lines: 94,
        statements: 91
      }
    }
  }
})
