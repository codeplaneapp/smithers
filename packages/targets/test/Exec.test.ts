/**
 * The exec boundary's workspace confinement.
 *
 * Every path this action hands a child process is confined to the workspace,
 * symbolic links included. The cache directory is one of those paths: it is
 * substituted into argv immediately before the spawn, so a workspace whose
 * `.flows` is a link to somewhere else would otherwise hand a tool a directory
 * outside the workspace to write into.
 */
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Exec from "../src/Exec.ts"

let root: string
let outside: string

const payload = (argv: ReadonlyArray<string>, cwd = "."): Exec.Payload => ({
  cwd,
  argv: argv as [string, ...Array<string>],
  env: {},
  secrets: [],
  expectedExitCodes: [0],
  timeoutMs: Exec.defaultTimeoutMs
})

const run = (
  options: { readonly workspaceRoot: string; readonly cacheDirectory?: string | undefined },
  value: Exec.Payload
): Promise<Exit.Exit<Exec.Result, Exec.ExecError>> => Effect.runPromiseExit(Exec.run(options, value))

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-exec-")))
  outside = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-outside-")))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
  await Fs.rm(outside, { recursive: true, force: true })
})

describe("run", () => {
  it("inherits CI so spawned tools stay non-interactive on hosted runners", async () => {
    const previous = process.env.CI
    process.env.CI = "true"
    try {
      const exit = await run(
        { workspaceRoot: root },
        payload([
          "node",
          "-e",
          `require('node:fs').writeFileSync(process.argv[1], process.env.CI ?? "unset")`,
          "ci-probe.txt"
        ])
      )
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(await Fs.readFile(NodePath.join(root, "ci-probe.txt"), "utf8")).toBe("true")
    } finally {
      if (previous === undefined) delete process.env.CI
      else process.env.CI = previous
    }
  })

  it("substitutes the cache directory token for an ordinary directory", async () => {
    const exit = await run(
      { workspaceRoot: root, cacheDirectory: ".flows" },
      payload([
        "node",
        "-e",
        `require('node:fs').writeFileSync(process.argv[1], 'ok')`,
        `${Exec.cacheDirectoryToken}.txt`
      ])
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(await Fs.readFile(NodePath.join(root, ".flows.txt"), "utf8")).toBe("ok")
  })

  /**
   * The gap this closes: substitution ran before anything validated the
   * directory it substituted. `normalizeCacheDirectory` settles the lexical
   * question only, so a `.flows` that is a link out of the workspace was
   * handed straight to the child.
   */
  it("refuses to substitute a cache directory that is a link out of the workspace", async () => {
    await Fs.symlink(outside, NodePath.join(root, ".flows"))

    const exit = await run(
      { workspaceRoot: root, cacheDirectory: ".flows" },
      payload(["node", "-e", "0", Exec.cacheDirectoryToken])
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(await Fs.readdir(outside)).toEqual([])
  })

  it("refuses a working directory that leaves the workspace", async () => {
    await Fs.symlink(outside, NodePath.join(root, "linked"))
    const exit = await run({ workspaceRoot: root }, payload(["node", "-e", "0"], "linked"))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("reports the refusal with the unsubstituted argv", async () => {
    // The diagnostic names the declaration, not the host path the run refused
    // to resolve: a rejected substitution must not leak the location it would
    // have produced.
    await Fs.symlink(outside, NodePath.join(root, ".flows"))
    const exit = await run(
      { workspaceRoot: root, cacheDirectory: ".flows" },
      payload(["node", "-e", "0", Exec.cacheDirectoryToken])
    )

    if (!Exit.isFailure(exit)) throw new Error("expected a failure")
    const rendered = JSON.stringify(exit.cause)
    expect(rendered).toContain("leaves the workspace")
    expect(rendered).toContain("smthrs:cache-directory")
    expect(rendered).not.toContain(outside)
  })

  it("rejects accessor-backed payload data without invoking it", async () => {
    let calls = 0
    const value = payload(["node", "-e", "0"])
    Object.defineProperty(value.argv, "1", {
      enumerable: true,
      get: () => {
        calls += 1
        return "-e"
      }
    })

    expect(Exit.isFailure(await run({ workspaceRoot: root }, value))).toBe(true)
    expect(calls).toBe(0)
  })

  it("rejects a Proxy payload without invoking its traps", async () => {
    let calls = 0
    const value = new Proxy(payload(["node", "-e", "0"]), {
      ownKeys: (target) => {
        calls += 1
        return Reflect.ownKeys(target)
      }
    })

    expect(Exit.isFailure(await run({ workspaceRoot: root }, value))).toBe(true)
    expect(calls).toBe(0)
  })
})
