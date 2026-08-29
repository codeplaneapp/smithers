import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, it } from "vitest"

const packageRoot = fileURLToPath(new URL("../", import.meta.url))

describe("built artifacts", () => {
  it(
    "preserves service identity between root and subpath exports",
    () => {
      execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: packageRoot })
      execFileSync(process.execPath, ["test/fixtures/artifact-esm.mjs"], { cwd: packageRoot })
      execFileSync(process.execPath, ["test/fixtures/artifact-cjs.cjs"], { cwd: packageRoot })
    },
    // This case runs a real build and two cold Node processes: 11.2 s even on
    // an idle machine. The old 30 s left barely 3x headroom and blew past it
    // whenever the other workspaces built concurrently. Sized against that
    // measurement, and still finite so a wedged build fails the gate.
    180_000
  )
})
