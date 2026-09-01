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
      // adversarial Linear response fixtures, the `Retry-After` delay proof,
      // the wall-clock defaults on both freshness checks, and the refinement
      // tests for a claimed Bot API failure whose delivered ids are missing.
      //
      // The numbers are set to what the suite actually reaches, so any new
      // uncovered branch fails the gate rather than spending slack.
      //
      // What the remaining shortfall stands for, behavior by behavior:
      //
      // - `InitData`'s two `UNSUPPORTED` branches: a runtime with no
      //   `crypto.subtle`, and one whose Web Crypto lacks Ed25519. Node has
      //   both, and this package is in neither the Bun matrix in `ci/BUILD.ts`
      //   nor the browser-contract list in `scripts/browser-check.mjs`, so
      //   neither branch is reachable from here. Deleting them would be
      //   deleting the runtime check, not covering it.
      // - `CursorStore`'s SQLite read and write paths that fail after their
      //   migration ran, which needs a database broken between two statements.
      // - `TelegramClient`'s already-aborted `AbortSignal` branch, which needs
      //   an interrupt delivered between two synchronous statements.
      // - `Core.Channel`'s `map` placeholder, unreachable by construction: the
      //   provider decoder maps the event before `map` could run.
      // - `Signature`'s undecodable-digest tail, pre-existing.
      // - `Chunk`'s `splitsSurrogatePair` bounds guard: the walk only ever asks
      //   about an index inside the remaining text, so neither end is
      //   reachable. It is a guard on a private helper, not a behavior.
      // - The `?? ""` fallbacks on `Approval.token` and `callbackData`, whose
      //   parameters are already required strings.
      // - A real `fetch` transport failure mid-body. The live suites in
      //   `test/*Live.test.ts` cover the provider side when a credential is
      //   present.
      thresholds: {
        branches: 96.8,
        functions: 98.6,
        lines: 99.25,
        statements: 98.9
      }
    }
  }
})
