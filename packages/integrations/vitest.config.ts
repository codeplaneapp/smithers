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
      reportsDirectory: join(tmpdir(), `flows-integrations-coverage-${process.pid}`),
      include: ["src/**"],
      // Ratcheted to what the default gate reaches, in the shape
      // `packages/triggers` and `packages/scorers` use. Raise these when a
      // case closes; never lower them. Last raised in the round that added the
      // exactly-one-attempt proofs for non-idempotent writes, the `Effect.flip`
      // assertions on every documented typed-failure path, the adversarial
      // provider-response fixtures, and the boundary tests for `chunk`,
      // `SignalName`, and `Approval`.
      //
      // What the remaining shortfall stands for, behavior by behavior:
      //
      // - `InitData`'s `UNSUPPORTED` branches: a runtime with no `crypto.subtle`
      //   and one whose Web Crypto lacks Ed25519. Node has both, and this
      //   package has no Bun or Worker suite (see the cross-package note in the
      //   README), so neither branch is reachable from here.
      // - `CursorStore`'s SQLite paths that fail after their migration ran.
      // - `TelegramClient`'s already-aborted `AbortSignal` branch, which needs
      //   an interrupt delivered between two synchronous statements.
      // - `Core.Channel`'s `map` placeholder, which is unreachable by
      //   construction: the provider decoder maps the event.
      // - A real `fetch` transport failure mid-body. The live suites in
      //   `test/*Live.test.ts` cover the provider side when a credential is
      //   present.
      thresholds: {
        branches: 95,
        functions: 98.5,
        lines: 99.2,
        statements: 98.7
      }
    }
  }
})
