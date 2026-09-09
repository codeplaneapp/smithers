/**
 * The exec boundary's workspace confinement.
 *
 * Every path this action hands a child process is confined to the workspace,
 * symbolic links included. The cache directory is one of those paths: it is
 * substituted into argv immediately before the spawn, so a workspace whose
 * `.flows` is a link to somewhere else would otherwise hand a tool a directory
 * outside the workspace to write into.
 */
import { Flow, FlowRuntime } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Latch from "effect/Latch"
import * as Layer from "effect/Layer"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Changesets from "../src/Changesets.ts"
import * as Exec from "../src/Exec.ts"
import * as Secret from "../src/Secret.ts"
import * as Target from "../src/Target.ts"

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
  it("executes the catalog refusal through its live layer", async () => {
    type Registered = (
      input: { readonly target: string },
      executionId: string
    ) => Effect.Effect<never, Target.NotImplemented>
    let registered: Registered | undefined
    const runtime = FlowRuntime.FlowRuntime.of(
      {
        register: (_flow: unknown, execute: Registered) =>
          Effect.sync(() => {
            registered = execute
          }),
        actionExecute: (action: { readonly execute: Effect.Effect<unknown, unknown> }) =>
          Effect.map(Effect.exit(action.execute), (exit) => new Flow.Complete({ exit }))
      } as unknown as FlowRuntime.FlowRuntime["Service"]
    )

    const exit = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      yield* Layer.build(
        Target.layerNotImplemented.pipe(Layer.provide(Layer.succeed(FlowRuntime.FlowRuntime, runtime)))
      )
      if (registered === undefined) throw new Error("catalog refusal action was not registered")
      const instance = FlowRuntime.FlowInstance.of({
        executionId: "catalog-refusal-probe",
        actionState: { count: 0, latch: Latch.makeUnsafe() }
      } as never)
      return yield* Effect.exit(registered({ target: "Catalog.Probe" }, "catalog-refusal-probe")).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, instance),
        Effect.provideService(FlowRuntime.FlowRuntime, runtime)
      )
    })))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("executes the irreversible action through its live layer", async () => {
    type Registered = (
      input: Exec.Payload,
      executionId: string
    ) => Effect.Effect<Exec.Result, Exec.ExecError>
    let registered: Registered | undefined
    const runtime = FlowRuntime.FlowRuntime.of(
      {
        register: (_flow: unknown, execute: Registered) =>
          Effect.sync(() => {
            registered = execute
          }),
        actionExecute: (action: { readonly execute: Effect.Effect<unknown, unknown> }) =>
          Effect.map(Effect.exit(action.execute), (exit) => new Flow.Complete({ exit }))
      } as unknown as FlowRuntime.FlowRuntime["Service"]
    )

    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      yield* Layer.build(
        Changesets.ExecIrreversibleLive({ workspaceRoot: root }).pipe(
          Layer.provide(Layer.succeed(FlowRuntime.FlowRuntime, runtime))
        )
      )
      if (registered === undefined) throw new Error("irreversible exec action was not registered")
      const instance = FlowRuntime.FlowInstance.of({
        executionId: "exec-irreversible-probe",
        actionState: { count: 0, latch: Latch.makeUnsafe() }
      } as never)
      return yield* registered(payload(["node", "-e", "process.stdout.write('ok')"]), "exec-irreversible-probe").pipe(
        Effect.provideService(FlowRuntime.FlowInstance, instance),
        Effect.provideService(FlowRuntime.FlowRuntime, runtime)
      )
    })))
    expect(result.stdout).toBe("ok")
    expect(result.exitCode).toBe(0)
  })

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

  it("substitutes the checked cache root when the child runs in a subdirectory", async () => {
    await Fs.mkdir(NodePath.join(root, "sub"))
    const exit = await run(
      { workspaceRoot: root, cacheDirectory: ".flows" },
      payload([
        "node",
        "-e",
        `const fs = require('node:fs');
         fs.mkdirSync(require('node:path').dirname(process.argv[1]), { recursive: true });
         fs.writeFileSync(process.argv[1], 'ok');`,
        `${Exec.cacheDirectoryToken}/probe.txt`
      ], "sub")
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(await Fs.readdir(NodePath.join(root, "sub"))).toEqual([])
    expect(await Fs.readFile(NodePath.join(root, ".flows", "probe.txt"), "utf8")).toBe("ok")
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

  it("names the payload member a caller left out rather than decoding around it", async () => {
    // `requiredDataMember` is what stands between a half-written payload and a
    // schema decode that would report the absence as a type mismatch three
    // layers down. The member is named so the author knows which one to add.
    const incomplete = payload(["node", "-e", "0"]) as Record<string, unknown>
    delete incomplete["timeoutMs"]

    expect((await failed(incomplete as Exec.Payload)).stderr).toContain("exec payload.timeoutMs is missing")
  })

  it("refuses a list longer than the bound its member declares", async () => {
    // Each list in the payload carries its own bound, and the refusal names the
    // list rather than the payload, so a caller generating exit codes in a loop
    // is pointed at the loop.
    const tooManyExitCodes = {
      ...payload(["node", "-e", "0"]),
      expectedExitCodes: Array.from({ length: 257 }, (_, index) => index)
    }

    expect((await failed(tooManyExitCodes)).stderr).toContain("exec expected exit codes has more than 256 entries")
  })

  it("refuses more sensitive environment names than it will fold", async () => {
    const names = Array.from({ length: 4_097 }, (_, index) => `SENSITIVE_${index}`)

    expect(
      (await failed(payload(["node", "-e", "0"]), { workspaceRoot: root, sensitiveEnv: names })).stderr
    ).toContain("too many sensitive environment names")
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

  it("flushes a partial UTF-8 sequence when the command times out", async () => {
    const error = await failed(
      {
        ...payload([
          process.execPath,
          "-e",
          "process.stdout.write(Buffer.from([0x61,0xe2,0x82]));setInterval(()=>{},1000)"
        ]),
        timeoutMs: 2000
      }
    )
    expect(error.code).toBe("timed_out")
    expect(error.stdout).toBe("a\uFFFD")
    expect(error.stderr).toContain("timed out")
  })

  it("keeps complete capture when optional output observers throw", async () => {
    const result = await Effect.runPromise(Exec.run({
      workspaceRoot: root,
      onStdout: () => {
        throw new Error("stdout observer failed")
      },
      onStderr: () => {
        throw new Error("stderr observer failed")
      }
    }, payload([process.execPath, "-e", "process.stdout.write('out');process.stderr.write('err')"])))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("out")
    expect(result.stderr).toBe("err")
  })
})

/**
 * The Windows half of the spawn: which file a bare command name names, and how
 * a batch shim reaches `cmd.exe`.
 *
 * `windows-latest` failed 61 of 67 package targets with `spawn pnpm ENOENT`
 * because pnpm installs as `pnpm.cmd` and libuv's own PATH walk appends only
 * `.com` and `.exe`. Nothing below needs a Windows host: `platform` and `env`
 * are parameters, and the fixture directory holds a real batch shim.
 *
 * Fixtures spell an extension in the same case as the `PATHEXT` entry that
 * finds it wherever the resolved path is asserted verbatim, so the assertion
 * reads the same on a case-sensitive and a case-insensitive filesystem. The
 * one test that deliberately mismatches the case says so.
 */
describe("windows executable resolution", () => {
  let bin: string
  const comspec = "C:\\WINDOWS\\system32\\cmd.exe"

  beforeEach(async () => {
    bin = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-winpath-")))
  })

  afterEach(async () => {
    await Fs.rm(bin, { recursive: true, force: true })
  })

  const shim = async (name: string): Promise<string> => {
    const path = NodePath.join(bin, name)
    await Fs.writeFile(path, "@echo off\n", { mode: 0o755 })
    return path
  }

  it("finds a PATHEXT extension libuv's own walk never appends", async () => {
    const shimPath = await shim("pnpm.CMD")
    expect(Exec.findOnPath("pnpm", { PATH: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD" }, { platform: "win32" }))
      .toBe(shimPath)
  })

  it("prefers the earlier PATHEXT entry and keeps PATH order", async () => {
    const second = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-winpath2-")))
    try {
      await shim("tool.CMD")
      await shim("tool.EXE")
      await Fs.writeFile(NodePath.join(second, "tool.EXE"), "MZ", { mode: 0o755 })
      expect(Exec.findAllOnPath("tool", { PATH: `${bin};${second}`, PATHEXT: ".EXE;.CMD" }, { platform: "win32" }))
        .toEqual([NodePath.join(bin, "tool.EXE"), NodePath.join(second, "tool.EXE")])
    } finally {
      await Fs.rm(second, { recursive: true, force: true })
    }
  })

  it("tries a spelled-out extension first, and falls back to the default extension list", async () => {
    await shim("runner.py")
    expect(Exec.findOnPath("runner.py", { PATH: bin }, { platform: "win32" }))
      .toBe(NodePath.join(bin, "runner.py"))
    await shim("other.EXE")
    expect(Exec.findOnPath("other", { PATH: bin, PATHEXT: "  " }, { platform: "win32" }))
      .toBe(NodePath.join(bin, "other.EXE"))
  })

  /** Windows folds both the command name and the extension; the lookup must too. */
  it("matches an extension whose case differs from PATHEXT's, and skips an unreadable directory", async () => {
    await shim("pnpm.cmd")
    const found = Exec.findOnPath(
      "PNPM",
      { Path: `${NodePath.join(bin, "missing")};${bin}` },
      { platform: "win32" }
    )
    expect(found === undefined ? undefined : NodePath.dirname(found)).toBe(bin)
    expect(found?.toLowerCase()).toBe(NodePath.join(bin, "pnpm.cmd").toLowerCase())
  })

  it("routes a batch shim through ComSpec with a verbatim, quoted line", async () => {
    const shimPath = await shim("pnpm.CMD")
    expect(
      Exec.spawnShape(["pnpm", "exec", "vitest", "run", "a b"], {
        platform: "win32",
        env: { PATH: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: comspec }
      })
    ).toEqual({
      file: comspec,
      args: ["/d", "/s", "/c", `""${shimPath}" "exec" "vitest" "run" "a b""`],
      windowsVerbatimArguments: true
    })
  })

  it("reads ComSpec case-insensitively and defaults it", () => {
    expect(Exec.spawnShape(["x.cmd"], { platform: "win32", env: { COMSPEC: "X:\\cmd.exe" } }).file)
      .toBe("X:\\cmd.exe")
    expect(Exec.spawnShape(["x.cmd"], { platform: "win32", env: {} }).file).toBe("cmd.exe")
  })

  it("doubles only a trailing backslash run, which would escape the closing quote", () => {
    expect(Exec.spawnShape(["x.cmd", "C:\\dir\\", "C:\\a\\b"], { platform: "win32", env: {} }).args[3])
      .toBe(`""x.cmd" "C:\\dir\\\\" "C:\\a\\b""`)
  })

  it("refuses an argument cmd.exe cannot carry, naming it", () => {
    for (const argument of ["say \"hi\"", "100%DONE%", "one\nline", "trailing\r"]) {
      expect(() => Exec.spawnShape(["x.cmd", argument], { platform: "win32", env: {} }))
        .toThrow(/cannot reach a Windows \.cmd shim/)
    }
  })

  it("spawns a resolved image directly, and leaves an unresolvable name to the host", async () => {
    await Fs.writeFile(NodePath.join(bin, "node.EXE"), "MZ", { mode: 0o755 })
    const environment = { PATH: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: comspec }
    expect(Exec.spawnShape(["node", "-e", "0"], { platform: "win32", env: environment })).toEqual({
      file: NodePath.join(bin, "node.EXE"),
      args: ["-e", "0"],
      windowsVerbatimArguments: false
    })
    expect(Exec.spawnShape(["absent-tool"], { platform: "win32", env: environment })).toEqual({
      file: "absent-tool",
      args: [],
      windowsVerbatimArguments: false
    })
    expect(Exec.spawnShape(["C:\\tools\\thing.exe", "--flag"], { platform: "win32", env: environment }).file)
      .toBe("C:\\tools\\thing.exe")
  })

  it("leaves POSIX exactly as it was: argv[0] verbatim, one candidate name, no PATHEXT", async () => {
    const shimPath = await shim("pnpm.CMD")
    const environment = { PATH: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD" }
    expect(Exec.findOnPath("pnpm", environment, { platform: "linux" })).toBeUndefined()
    expect(Exec.findAllOnPath("pnpm.CMD", environment, { platform: "linux" })).toEqual([shimPath])
    expect(Exec.spawnShape(["pnpm", "exec", "vitest"], { platform: "linux", env: environment })).toEqual({
      file: "pnpm",
      args: ["exec", "vitest"],
      windowsVerbatimArguments: false
    })
  })

  it("reads the ambient platform and environment when neither is given", async () => {
    const shimPath = await shim("host-tool")
    const previous = process.env["PATH"]
    process.env["PATH"] = bin
    try {
      expect(Exec.findOnPath("host-tool")).toBe(process.platform === "win32" ? undefined : shimPath)
      expect(Exec.findAllOnPath("host-tool")).toEqual(process.platform === "win32" ? [] : [shimPath])
    } finally {
      if (previous === undefined) delete process.env["PATH"]
      else process.env["PATH"] = previous
    }
    expect(Exec.spawnShape([process.execPath, "-e", "0"]))
      .toEqual({ file: process.execPath, args: ["-e", "0"], windowsVerbatimArguments: false })
  })
})
