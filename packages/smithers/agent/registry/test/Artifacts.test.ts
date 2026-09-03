import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, it } from "vitest"

const packageRoot = fileURLToPath(new URL("../", import.meta.url))

describe("built artifacts", () => {
  it(
    "preserves constructor identity between CJS root and subpath exports",
    () => {
      execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: packageRoot })
      execFileSync(process.execPath, ["test/fixtures/artifact-cjs.cjs"], { cwd: packageRoot })
    },
    120_000
  )
})
