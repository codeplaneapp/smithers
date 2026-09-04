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
      // Runtime identity is only half of what is published. This type-checks a
      // consumer against the export map npm writes, so a type the package
      // exports but the packed declarations do not reach is a failure here
      // rather than in someone's editor. Measured at 1.2 s on top of the build.
      execFileSync(process.execPath, ["test/fixtures/artifact-types.mjs"], { cwd: packageRoot })
    },
    // This case runs a real build and two cold Node processes, so it is the
    // slowest in the repo: 13.5 s here even on an idle machine. The old 30 s
    // left barely 2x headroom and blew past it whenever the other workspaces
    // built concurrently. Sized against that measurement, not guessed, and
    // still finite so a wedged build fails rather than hanging the gate.
    180_000
  )
})
