import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    // House convention (see packages/journal/vitest.config.ts): a finite 30 s
    // wall-clock budget so correct suites survive coverage-instrumented load
    // while a genuine hang still fails the run.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      enabled: true,
      provider: "v8",
      // Per-process report directory so concurrent vitest runs do not destroy
      // each other's coverage scratch state (issues #115/#121).
      reportsDirectory: join(tmpdir(), `flows-registry-coverage-${process.pid}`),
      include: ["src/**"],
      // Everything reachable is covered. The remainder is four defensive
      // guards that no input can reach: the `?? ""` fallbacks in
      // `ModuleMetadata.skipTrivia` and `ModuleMetadata.nextToken` (both sit
      // behind an `index < source.length` check, so the indexed read is always
      // a string), the unmatched-brace return in
      // `ModuleMetadata.objectProperties` (every property value is sliced out
      // of an already brace-balanced declaration), and the `Option.getOrElse`
      // fallback in `Discovery` module naming (a path-named source rejects
      // root-level entries, so its path-derived name is always present).
      //
      // The percentages moved when `Executable.ts` joined the denominator; the
      // four guards above are still the whole of what is uncovered.
      thresholds: {
        branches: 99.7,
        functions: 99.47,
        lines: 99.79,
        statements: 99.8
      }
    }
  }
})
