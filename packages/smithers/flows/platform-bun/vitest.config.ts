import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      enabled: true,
      provider: "v8",
      reportsDirectory: join(tmpdir(), `flows-platform-bun-coverage-${process.pid}`),
      include: ["src/**/*.ts"].map((pattern) => join(import.meta.dirname, pattern)),
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 }
    }
  }
})
