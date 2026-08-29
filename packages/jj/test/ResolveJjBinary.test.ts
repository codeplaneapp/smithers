/**
 * The `jj` resolution order `smithers doctor` reports on.
 *
 * The 0.x requirement this carries forward (`packages/vcs/tests/
 * resolve-jj-binary.test.js`, `jj-eacces-and-fallbacks.test.js`): an explicit
 * `SMITHERS_JJ_PATH` that names a real file stays authoritative even when the
 * file cannot be executed, and a host with no usable `jj` falls back to the
 * bare command name rather than failing at resolution time.
 */
import { describe, expect, it } from "@effect/vitest"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import * as Resolve from "../src/node/resolveJjBinary.ts"

const staged = <A>(use: (directory: string) => A): A => {
  const directory = mkdtempSync(join(tmpdir(), "resolve-jj-"))
  try {
    return use(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const write = (file: string, mode: number): string => {
  writeFileSync(file, "#!/bin/sh\nexit 0\n")
  chmodSync(file, mode)
  return file
}

describe("resolveJjBinary", () => {
  it("honours SMITHERS_JJ_PATH when it names an executable file", () =>
    staged((directory) => {
      const binary = write(join(directory, "jj"), 0o755)
      const resolved = Resolve.resolveJjBinary({ environment: { SMITHERS_JJ_PATH: binary }, platform: "linux" })

      expect(resolved).toEqual({ path: binary, source: "env", executable: true })
      expect(Resolve.describe(resolved)).toBe(`jj: ${binary} (SMITHERS_JJ_PATH)`)
    }))

  it("keeps a non-executable override authoritative and explains why it fails", () =>
    staged((directory) => {
      const binary = write(join(directory, "jj"), 0o644)
      const resolved = Resolve.resolveJjBinary({ environment: { SMITHERS_JJ_PATH: binary }, platform: "linux" })

      expect(resolved.source).toBe("env")
      expect(resolved.executable).toBe(false)
      expect(resolved.hint).toContain("chmod +x")
      expect(resolved.hint).not.toContain("xattr")
      expect(Resolve.describe(resolved)).toContain("chmod +x")
    }))

  it("adds the macOS quarantine tip only on darwin", () => {
    expect(Resolve.permissionHint("/opt/jj", "darwin")).toContain("xattr -d com.apple.quarantine")
    expect(Resolve.permissionHint("/opt/jj", "linux")).not.toContain("xattr")
  })

  it("reads FLOWS_JJ_PATH as the rc.0 alias, after the SMITHERS name", () =>
    staged((directory) => {
      const preferred = write(join(directory, "preferred"), 0o755)
      const alias = write(join(directory, "alias"), 0o755)

      expect(Resolve.resolveJjBinary({ environment: { FLOWS_JJ_PATH: alias }, platform: "linux" }).path).toBe(alias)
      expect(
        Resolve.resolveJjBinary({
          environment: { SMITHERS_JJ_PATH: preferred, FLOWS_JJ_PATH: alias },
          platform: "linux"
        }).path
      ).toBe(preferred)
      expect(Resolve.overrideVariables).toEqual(["SMITHERS_JJ_PATH", "FLOWS_JJ_PATH"])
    }))

  it("ignores an empty or missing override and searches PATH", () =>
    staged((directory) => {
      const binary = write(join(directory, "jj"), 0o755)
      const environment = {
        SMITHERS_JJ_PATH: "",
        FLOWS_JJ_PATH: join(directory, "absent"),
        PATH: `${join(directory, "empty")}${delimiter}${directory}`
      }

      const resolved = Resolve.resolveJjBinary({ environment, platform: "linux" })

      expect(resolved).toEqual({ path: binary, source: "path", executable: true })
      expect(Resolve.describe(resolved)).toBe(`jj: ${binary}`)
    }))

  it("skips empty PATH entries and looks for jj.exe on Windows", () =>
    staged((directory) => {
      const binary = write(join(directory, "jj.exe"), 0o644)
      const resolved = Resolve.resolveJjBinary({
        environment: { Path: `${delimiter}${directory}` },
        platform: "win32"
      })

      expect(resolved).toEqual({ path: binary, source: "path", executable: true })
    }))

  it("falls back to the bare command name when nothing on PATH is jj", () => {
    const resolved = Resolve.resolveJjBinary({ environment: {}, platform: "linux" })

    expect(resolved).toEqual({
      path: "jj",
      source: "path",
      executable: false,
      hint: "No jj on PATH. Install jj (https://jj-vcs.github.io) or set SMITHERS_JJ_PATH."
    })
    expect(Resolve.describe(resolved)).toContain("not found")
  })

  it("treats an empty PATH the same as an unset one", () => {
    expect(Resolve.resolveJjBinary({ environment: { PATH: "" }, platform: "linux" }).path).toBe("jj")
  })

  it("probes execute access on POSIX and existence on Windows", () => {
    const calls: Array<readonly [string, number]> = []
    const access = (file: string, mode: number) => {
      calls.push([file, mode])
    }

    expect(Resolve.isExecutable("/tmp/jj", { platform: "linux", access })).toBe(true)
    expect(Resolve.isExecutable("C:\\jj.exe", { platform: "win32", access })).toBe(true)
    expect(calls).toEqual([["/tmp/jj", 1], ["C:\\jj.exe", 0]])
  })

  it("reports a candidate the operating system refuses as not executable", () => {
    const access = () => {
      throw new Error("EACCES: permission denied")
    }

    expect(Resolve.isExecutable("/tmp/jj", { platform: "linux", access })).toBe(false)
  })

  it("resolves against the real process environment by default", () => {
    const resolved = Resolve.resolveJjBinary()

    expect(["env", "path"]).toContain(resolved.source)
    expect(typeof resolved.path).toBe("string")
    expect(Resolve.isExecutable(resolved.path)).toBe(resolved.executable || resolved.path === "jj")
  })
})
