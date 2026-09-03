/** Cross-process cache-key identity over a real CLI fixture. */
import { spawn } from "node:child_process"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"

const cli = NodePath.resolve(import.meta.dirname, "../src/main.js")
const fixture = NodePath.resolve(import.meta.dirname, "fixtures/implementation-identity")
const repository = NodePath.resolve(import.meta.dirname, "../../..")

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
      "//packages/build-cli/test/fixtures/implementation-identity/...",
      "--workspace",
      repository,
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
    expect(JSON.parse(firstBytes.toString())).toHaveLength(1)
    expect(secondBytes).toEqual(firstBytes)
  })
})
