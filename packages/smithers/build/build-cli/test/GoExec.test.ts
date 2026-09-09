import { Smithers as S } from "@smthrs/targets"
import * as NodeChildProcess from "node:child_process"
import * as Os from "node:os"
import { describe, expect, it, vi } from "vitest"
import * as GoExec from "../src/GoExec.ts"
import * as PackageTree from "../src/PackageTree.ts"

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>()
  return { ...actual, execFile: vi.fn(actual.execFile) }
})

describe("Go planning subprocess bounds", () => {
  it.each(["go list", "nix"] as const)("aborts a hung %s probe", async (kind) => {
    const controller = new AbortController()
    const actual = await vi.importActual<typeof NodeChildProcess>("node:child_process")
    vi.mocked(NodeChildProcess.execFile).mockImplementationOnce(
      ((
        file: string,
        args: ReadonlyArray<string>,
        options: NodeChildProcess.ExecFileOptionsWithStringEncoding,
        callback: (error: NodeChildProcess.ExecFileException | null, stdout: string, stderr: string) => void
      ) => {
        const child = actual.execFile(
          process.execPath,
          ["-e", "setTimeout(() => process.exit(9), 1500)"],
          options,
          callback
        )
        setTimeout(() => controller.abort(), 20)
        return child
      }) as typeof NodeChildProcess.execFile
    )
    const context = {
      root: Os.tmpdir(),
      packagePath: "",
      signal: controller.signal,
      workspace: S.Workspace("bounds", {
        repository: "git+https://example.test/bounds.git",
        cache: S.Cache({ directory: ".flows" }),
        toolchains: [
          S.Go.Toolchain({
            mod: S.file("//go.mod"),
            sum: S.file("//go.sum"),
            versions: S.Nix.DevShell({ flake: S.file("//flake.nix"), lock: S.file("//flake.lock") })
          })
        ]
      })
    }
    if (kind === "go list") {
      await expect(GoExec.planRule("Go.Packages", { pkgs: ["./..."] }, context, process.execPath))
        .rejects.toThrow(/abort/i)
    } else {
      const found = vi.spyOn(PackageTree, "findOnPath").mockReturnValue(process.execPath)
      try {
        const result = await GoExec.resolveNix("go", context)
        expect(result).toMatchObject({ ok: false, refusal: expect.stringMatching(/abort/i) })
      } finally {
        found.mockRestore()
      }
    }
    expect(vi.mocked(NodeChildProcess.execFile).mock.calls.at(-1)?.[2]).toMatchObject({
      signal: controller.signal,
      timeout: kind === "nix" ? 300_000 : 60_000
    })
  })

  it("times out go list with the context deadline", async () => {
    const actual = await vi.importActual<typeof NodeChildProcess>("node:child_process")
    vi.mocked(NodeChildProcess.execFile).mockImplementationOnce(
      ((
        file: string,
        args: ReadonlyArray<string>,
        options: NodeChildProcess.ExecFileOptionsWithStringEncoding,
        callback: (error: NodeChildProcess.ExecFileException | null, stdout: string, stderr: string) => void
      ) =>
        actual.execFile(
          process.execPath,
          ["-e", "setTimeout(() => process.exit(9), 1500)"],
          options,
          callback
        )) as typeof NodeChildProcess.execFile
    )
    await expect(GoExec.planRule("Go.Packages", { pkgs: ["./..."] }, {
      root: Os.tmpdir(),
      packagePath: "",
      timeoutMs: 30,
      workspace: S.Workspace("bounds", {
        repository: "git+https://example.test/bounds.git",
        cache: S.Cache({ directory: ".flows" }),
        toolchains: [
          S.Go.Toolchain({
            mod: S.file("//go.mod"),
            sum: S.file("//go.sum"),
            versions: S.Nix.DevShell({ flake: S.file("//flake.nix"), lock: S.file("//flake.lock") })
          })
        ]
      })
    }, process.execPath)).rejects.toThrow(/timed out after 30ms/)
  })
})
