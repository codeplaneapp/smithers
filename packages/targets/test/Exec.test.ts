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
import * as Secret from "../src/Secret.ts"

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

const failed = async (value: Exec.Payload, options: Parameters<typeof Exec.run>[0] = { workspaceRoot: root }) => {
  const exit = await Effect.runPromiseExit(Exec.run(options, value))
  if (Exit.isSuccess(exit)) throw new Error("expected an exec failure")
  const rendered = JSON.stringify(exit.cause)
  const parsed = JSON.parse(rendered) as { readonly failures?: ReadonlyArray<{ readonly error: Exec.ExecError }> }
  const error = parsed.failures?.[0]?.error
  if (error === undefined) throw new Error(`expected an ExecError: ${rendered}`)
  return error
}

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

  it("rejects hostile payload records with a typed diagnostic", async () => {
    const inherited = Object.assign(Object.create({ inherited: true }) as object, payload(["node", "-e", "0"]))
    expect((await failed(inherited as Exec.Payload)).stderr).toContain("plain object")

    const unknown = { ...payload(["node", "-e", "0"]), typo: true }
    expect((await failed(unknown as Exec.Payload)).stderr).toContain("unknown property")

    const symbol = payload(["node", "-e", "0"]) as Exec.Payload & Record<PropertyKey, unknown>
    symbol[Symbol("extra")] = true
    expect((await failed(symbol)).stderr).toContain("unknown property")

    const nonEnumerable = payload(["node", "-e", "0"])
    Object.defineProperty(nonEnumerable, "cwd", { value: ".", enumerable: false })
    expect((await failed(nonEnumerable)).stderr).toContain("enumerable data property")
  })

  it("rejects arrays whose shape could hide or replace an argument", async () => {
    const wrongPrototype = payload(["node", "-e", "0"])
    Object.setPrototypeOf(wrongPrototype.argv, null)
    expect((await failed(wrongPrototype)).stderr).toContain("exec argv must be an array")

    const decorated = payload(["node", "-e", "0"])
    Object.defineProperty(decorated.argv, "extra", { value: true })
    expect((await failed(decorated)).stderr).toContain("dense array without extra properties")

    const missing = payload(["node", "-e", "0"])
    delete (missing.argv as unknown as Array<string>)[1]
    Object.defineProperty(missing.argv, "extra", { value: "balanced-name-count" })
    expect((await failed(missing)).stderr).toContain("dense array without extra properties")
  })

  it("rejects environment and executable declarations that are not portable", async () => {
    const symbolEnvironment = payload(["node", "-e", "0"])
    const env = symbolEnvironment.env as Record<PropertyKey, string>
    env[Symbol("hidden")] = "value"
    expect((await failed(symbolEnvironment)).stderr).toContain("symbol property")

    expect((await failed(payload(["", "-e", "0"]))).stderr).toContain("must name an executable")
    const wideArgument = "é".repeat(600_000)
    expect((await failed(payload(["node", wideArgument, wideArgument]))).stderr).toContain("exec argv exceeds")
    expect(
      (await failed({
        ...payload(["node", "-e", "0"]),
        env: { Name: "first", NAME: "second" }
      })).stderr
    ).toContain("repeats a case-insensitive name")
    expect(
      (await failed({
        ...payload(["node", "-e", "0"]),
        env: { LARGE: "x".repeat(2 * 1024 * 1024 + 1) }
      })).stderr
    ).toContain("environment exceeds")
    expect(
      (await failed(payload(["node", "-e", "0"]), {
        workspaceRoot: root,
        sensitiveEnv: ["not-portable"]
      })).stderr
    ).toContain("sensitive environment name is not portable")
  })

  it("rejects duplicate secret bindings and conflicts with declared environment", async () => {
    const credential = Secret.HttpSecret(Secret.Secret("EXEC_TEST_TOKEN"), ["https://example.test"])
    expect(
      (await failed({
        ...payload(["node", "-e", "0"]),
        secrets: [credential, credential]
      })).stderr
    ).toContain("declares the secret \"EXEC_TEST_TOKEN\" twice")
    expect(
      (await failed({
        ...payload(["node", "-e", "0"]),
        env: { EXEC_TEST_TOKEN: "not-secret" },
        secrets: [credential]
      })).stderr
    ).toContain("also declares it as a secret")
  })

  it("resolves runtime and script placeholders immediately before the real spawn", async () => {
    const exit = await run(
      { workspaceRoot: root },
      {
        ...payload([
          Exec.runtimeBinToken,
          "-e",
          "process.stdout.write(process.argv[1])",
          `${Exec.scriptTokenPrefix}//scripts/generate.mjs}`
        ]),
        after: { completed: true }
      }
    )
    if (!Exit.isSuccess(exit)) throw new Error(`expected success: ${JSON.stringify(exit.cause)}`)
    expect(exit.value.stdout).toBe("scripts/generate.mjs")
  })

  it("streams the exact stdout and stderr bytes to declared observers", async () => {
    const stdout: Array<number> = []
    const stderr: Array<number> = []
    const exit = await Effect.runPromiseExit(Exec.run({
      workspaceRoot: root,
      onStdout: (chunk) => stdout.push(...chunk),
      onStderr: (chunk) => stderr.push(...chunk)
    }, payload([process.execPath, "-e", "process.stdout.write('out'); process.stderr.write('err')"])))
    if (!Exit.isSuccess(exit)) throw new Error(`expected success: ${JSON.stringify(exit.cause)}`)
    expect(Buffer.from(stdout).toString("utf8")).toBe("out")
    expect(Buffer.from(stderr).toString("utf8")).toBe("err")
  })
})
