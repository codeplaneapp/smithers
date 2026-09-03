import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, it } from "vitest"

const packageRoot = fileURLToPath(new URL("../", import.meta.url))

describe("built artifacts", () => {
  it(
    "preserves constructor identity between root and subpath exports",
    () => {
      execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: packageRoot })
      execFileSync(process.execPath, ["test/fixtures/artifact-esm.mjs"], { cwd: packageRoot })
      execFileSync(process.execPath, ["test/fixtures/artifact-cjs.cjs"], { cwd: packageRoot })
    },
    // This case runs a real build and two cold Node processes. It is 2.8 s on
    // an idle machine but was measured at 33.8 s when the other workspaces
    // built concurrently — the same ~12x load multiplier the package
    // `testTimeout` budgets for. Still finite so a wedged build fails.
    180_000
  )
})
