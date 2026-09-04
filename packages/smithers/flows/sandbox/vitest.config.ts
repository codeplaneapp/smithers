import { tmpdir } from "node:os"
import { join } from "node:path"
import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // The fault tier lives under `test/faults` and runs from
    // `vitest.faults.config.ts` instead, serially and without coverage: its
    // cases kill process groups and bind ports, which no unit suite sharing
    // this machine can survive beside them.
    include: ["test/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "test/faults/**"],
    environment: "node",
    coverage: {
      enabled: true,
      provider: "v8",
      reportsDirectory: join(tmpdir(), `flows-sandbox-coverage-${process.pid}`),
      include: ["src/**/*.ts"].map((pattern) => join(import.meta.dirname, pattern)),
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 }
    }
  }
})
