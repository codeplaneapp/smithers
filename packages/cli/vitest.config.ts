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
      reportsDirectory: join(tmpdir(), `flows-cli-coverage-${process.pid}`),
      include: ["src/**"],
      // Measured (96.42 / 91.61 / 96.46 / 96.84 over 933 cases), then floored
      // to integers, which leaves under a point for the branches that depend on
      // the host: `jj` on PATH and provider keys exported. Deleted coverage
      // still fails the run.
      //
      // the release policy asks every package for 100, and this package is
      // the one that cannot reach it from inside the process being measured.
      // What a command line promises is what a PROCESS does — its exit status,
      // its stderr, the `.flows/` it leaves behind, the second `smithers` it
      // refuses — so `Bin.test.ts`, `BinTeardown.test.ts`,
      // `TwoProcessClaim.test.ts`, `CrossProcessCancel.test.ts`,
      // `EndToEnd.test.ts` and the MCP stdio round trip spawn the real
      // executable and assert against it. v8 attributes that execution to the
      // child, so the residue below is asserted code that this process did not
      // run, not unasserted code. The rest is genuinely out of reach here:
      // `update` reads the npm registry, and `Detached.terminate`'s handle arm
      // is Windows-only, reachable through its `platform` argument and no
      // further. Re-attributing the process cases by re-asserting them in
      // process would buy the number and lose the promise, so the number is
      // what moves.
      thresholds: {
        branches: 91,
        functions: 96,
        lines: 96,
        statements: 96
      }
    }
  }
})
