/** Cross-process cache-key identity over a real CLI fixture. */
import { spawn } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const cli = NodePath.resolve(import.meta.dirname, "../src/main.js")

/**
 * The fixture is staged into a temporary directory rather than kept under
 * `test/fixtures/`. `Workspace` treats every tracked `BUILD.ts` as a package
 * of the repository's own graph, so a fixture that lived in the tree was
 * discovered and executed by `smithers-build ci '//packages/...'`, and its
 * build wrote `out` into the repository root on every CI run.
 */
let fixture = ""

beforeAll(async () => {
  fixture = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-implementation-identity-"))
  await Fs.writeFile(
    NodePath.join(fixture, "BUILD.ts"),
    [
      "import { Smithers } from \"@smthrs/targets\"",
      "",
      "export const sources = Smithers.Filegroup({ srcs: [Smithers.file(\"//input.txt\")], cwd: \".\" })",
      "",
      "export const build = Smithers.ToolBuild({",
      "  tool: \"node\",",
      "  command: \"node\",",
      "  args: [\"-e\", \"require('node:fs').writeFileSync('out', 'built')\"],",
      "  inputs: [Smithers.file(\"//input.txt\")],",
      "  outputs: [\"out\"],",
      "  deps: [sources],",
      "  env: {},",
      "  cache: true,",
      "  cwd: \".\"",
      "})",
      ""
    ].join("\n")
  )
  await Fs.writeFile(NodePath.join(fixture, "input.txt"), "stable input\n")
  await Fs.writeFile(
    NodePath.join(fixture, "package.json"),
    `${JSON.stringify({ name: "implementation-identity-fixture", private: true, type: "module" }, undefined, 2)}\n`
  )
})

afterAll(async () => {
  if (fixture !== "") await Fs.rm(fixture, { recursive: true, force: true })
})

interface ProcessResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

const plan = (): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      cli,
      "build",
      "//...",
      "--workspace",
      fixture,
      "--plan",
      "--format",
      "json"
    ], { cwd: fixture, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => stdout += chunk)
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => stderr += chunk)
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })

const keyMaterialBytes = (stdout: string): Buffer => {
  const parsed = JSON.parse(stdout) as {
    readonly targets: ReadonlyArray<{ readonly label: string; readonly keyMaterial: unknown }>
  }
  return Buffer.from(JSON.stringify(
    parsed.targets.map(({ keyMaterial, label }) => ({ label, keyMaterial }))
  ))
}

describe("implementation identity", () => {
  it("prints byte-identical key material for every target in separate CLI processes", async () => {
    const first = await plan()
    const second = await plan()

    expect(first.code, `${first.stderr}\n${first.stdout}`).toBe(0)
    expect(second.code, `${second.stderr}\n${second.stdout}`).toBe(0)
    const firstBytes = keyMaterialBytes(first.stdout)
    const secondBytes = keyMaterialBytes(second.stdout)
    expect(JSON.parse(firstBytes.toString())).toHaveLength(2)
    expect(secondBytes).toEqual(firstBytes)
  })
})
