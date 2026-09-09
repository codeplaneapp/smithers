import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DepsLint } from "../src/DepsLint.ts"
import * as Exec from "../src/Exec.ts"
import * as Input from "../src/Input.ts"
import { plannedCalls } from "./plan.ts"
import { packageManager, runtime } from "./toolchain.ts"

let root: string

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-deps-lint-")))
  await Fs.mkdir(NodePath.join(root, "packages/example"), { recursive: true })
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("DepsLint", () => {
  it("reads the generated workspace cache config from the package cwd", async () => {
    const calls = plannedCalls(DepsLint({
      packageManager,
      runtime,
      packageJson: Input.file("packages/example/package.json"),
      sources: [],
      deps: [],
      cwd: "packages/example",
      tool: "knip",
      ignoreDependencies: ["optional-package"],
      ignoreBinaries: ["optional-binary"]
    }))
    expect(calls).toHaveLength(2)
    const defaults = {
      env: {},
      secrets: [],
      expectedExitCodes: [0],
      timeoutMs: Exec.defaultTimeoutMs
    }
    const write = { ...defaults, ...calls[0]!.payload } as unknown as Exec.Payload
    const lint = { ...defaults, ...calls[1]!.payload } as unknown as Exec.Payload
    await Effect.runPromise(Exec.run({ workspaceRoot: root }, write))

    // Stand in for knip while preserving its planned cwd and config argument.
    const configIndex = lint.argv.indexOf("--config")
    expect(configIndex).toBeGreaterThan(-1)
    const configPath = lint.argv[configIndex + 1]!
    const result = await Effect.runPromise(Exec.run({ workspaceRoot: root }, {
      ...lint,
      argv: [
        "node",
        "-e",
        `process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))`,
        configPath
      ]
    }))
    expect(JSON.parse(result.stdout)).toEqual({
      ignoreBinaries: ["optional-binary"],
      ignoreDependencies: ["optional-package"]
    })
    expect(configPath).toBe(write.argv.at(-2))
    expect(configPath.startsWith(`${Exec.cacheDirectoryToken}/knip-`)).toBe(true)
    expect(await Fs.readdir(NodePath.join(root, ".flows"))).toEqual([
      configPath.slice(Exec.cacheDirectoryToken.length + 1)
    ])
    expect(await Fs.readdir(NodePath.join(root, "packages/example"))).toEqual([])
  })
})
