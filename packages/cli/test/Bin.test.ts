import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { Version } from "../src/index.ts"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const executable = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
const shim = fileURLToPath(new URL("../bin/smithers.mjs", import.meta.url))
const temporaryDirectoryPrefix = fileURLToPath(new URL("../.tmp-cli-test-", import.meta.url))

const run = (args: ReadonlyArray<string>) => {
  const cwd = mkdtempSync(temporaryDirectoryPrefix)
  try {
    return spawnSync(process.execPath, ["--no-warnings", executable, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 30_000
    })
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

describe("smithers executable", () => {
  it("reports the package version", () => {
    const result = run(["--version"])

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(Version.packageVersion)
  })

  it("exits with usage status for malformed JSON input", () => {
    const result = run(["plan", "system/test", "--data", "{"])

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(2)
  })

  it("rejects the unsupported flow-list filter", () => {
    const result = run(["ls", "--filter", "review"])

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("--filter")
  })
})

describe("the smithers bin shim", () => {
  it("is the only binary the package declares, and ships in the tarball", () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      readonly bin?: Record<string, string>
      readonly files?: ReadonlyArray<string>
    }

    // The imported `flows` bin is gone and `@smthrs/cli` owns the one
    // user-facing name (rc-contract.md section 3.4).
    expect(manifest.bin).toEqual({ smithers: "./bin/smithers.mjs" })
    expect(manifest.files).toContain("bin/**/*.mjs")
  })

  // The packaged install path needs a built artifact, so it is a capability
  // gate: `dist/esm/bin.js` exists in every tarball and in a built checkout,
  // and the suite also runs before `pnpm run build` in a fresh clone.
  const built = existsSync(join(packageRoot, "dist", "esm", "bin.js"))

  it.skipIf(!built)("runs the built entry when dist is present", () => {
    const cwd = mkdtempSync(temporaryDirectoryPrefix)
    try {
      const result = spawnSync(process.execPath, [shim, "--version"], { cwd, encoding: "utf8", timeout: 30_000 })

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stdout).toContain(Version.packageVersion)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("runs the working-tree source when dist is absent", () => {
    // The development path `scripts/check-local-smithers.mjs` requires: a fresh
    // checkout has no `dist`, and `pnpm exec smithers` must still run the code
    // under edit rather than a published build. The shim is copied into a
    // package root that has `src` and no `dist`, which is exactly that shape.
    const root = mkdtempSync(temporaryDirectoryPrefix)
    try {
      mkdirSync(join(root, "bin"))
      copyFileSync(shim, join(root, "bin", "smithers.mjs"))
      symlinkSync(join(packageRoot, "src"), join(root, "src"), "dir")
      expect(existsSync(join(root, "dist"))).toBe(false)

      const result = spawnSync(process.execPath, [join(root, "bin", "smithers.mjs"), "--version"], {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000
      })

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stdout).toContain(Version.packageVersion)
      // Type stripping is experimental on Node 22; the shim silences that one
      // warning so a development invocation is not prefixed with a paragraph.
      expect(result.stderr).not.toContain("Type Stripping")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
