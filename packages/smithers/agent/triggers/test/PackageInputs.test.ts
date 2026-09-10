import { readFileSync } from "node:fs"
import { matchesGlob } from "node:path"
import { describe, expect, it } from "vitest"

// Read declarations without importing the build toolchain into this package's
// TypeScript compilation. This follows the review's static input probe.
const declaration = readFileSync(new URL("../PACKAGE.ts", import.meta.url), "utf8")
const macro = readFileSync(
  new URL("../../../../repo-targets/src/BuildAndCheckTypeScriptPackage.ts", import.meta.url),
  "utf8"
)

describe("package test inputs", () => {
  it("includes the shared store assertions in test and coverage cache inputs (packaging/1)", () => {
    const defaultGlob = /const tests = options.tests \?\? Input.glob\("([^"]+)"\)/.exec(macro)?.[1]
    const testGlob = /tests:\s*Smithers.glob\("([^"]+)"\)/.exec(declaration)?.[1] ?? defaultGlob
    expect(testGlob).toBeDefined()
    expect(matchesGlob("test/StoreConformance.ts", testGlob!)).toBe(true)
  })
})
