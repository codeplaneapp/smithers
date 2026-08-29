import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { Version } from "../src/index.ts"

const executable = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
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

describe("flows executable", () => {
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
