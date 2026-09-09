import { execFileSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const packageRoot = fileURLToPath(new URL("../", import.meta.url))

const copyPackage = (source: string): string => {
  const scratch = mkdtempSync(join(tmpdir(), "smithers-fs-artifacts-"))
  try {
    for (const path of ["src", "scripts", "test/fixtures", "tsconfig.json", "package.json"]) {
      cpSync(join(source, path), join(scratch, path), { recursive: true })
    }
    // Resolve dependencies from this worktree without copying the installed tree.
    symlinkSync(join(packageRoot, "node_modules"), join(scratch, "node_modules"), "junction")
    return scratch
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true })
    throw error
  }
}

const smokeArtifacts = (root: string): void => {
  // build.mjs owns dist relative to its own location. Copy its inputs so
  // neither the build nor the fixture imports touch another process's output.
  const scratch = copyPackage(root)
  try {
    execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: scratch, timeout: 120_000 })
    execFileSync(process.execPath, ["test/fixtures/artifact-esm.mjs"], { cwd: scratch, timeout: 20_000 })
    execFileSync(process.execPath, ["test/fixtures/artifact-cjs.cjs"], { cwd: scratch, timeout: 20_000 })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

describe("built artifacts", () => {
  it(
    "imports every documented ESM and CJS subpath with one root identity",
    () => {
      smokeArtifacts(packageRoot)
    },
    180_000
  )

  it("preserves output owned by another build", () => {
    // Use a private package fixture so this assertion cannot race a real build.
    const source = copyPackage(packageRoot)
    const sentinel = join(source, "dist", "another-build.txt")
    try {
      mkdirSync(join(source, "dist"))
      writeFileSync(sentinel, "owned by another build")
      smokeArtifacts(source)
      expect(readFileSync(sentinel, "utf8")).toBe("owned by another build")
    } finally {
      rmSync(source, { recursive: true, force: true })
    }
  }, 180_000)
})
