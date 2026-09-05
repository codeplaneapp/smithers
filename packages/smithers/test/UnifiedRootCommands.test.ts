import * as Audience from "@smthrs/build-cli/Audience"
import type { RuntimeConfig } from "@smthrs/build-cli/Cli"
import { Effect } from "effect"
import { resolve } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCli } from "../src/Cli.ts"
import * as Suggest from "../src/Suggest.ts"

const ports = vi.hoisted(() => ({
  invoke: vi.fn(),
  host: vi.fn(),
  initialize: vi.fn(),
  suggest: vi.fn(),
  isDirectory: vi.fn()
}))
vi.mock("../src/cli/ControlBridge.ts", async (load) => ({
  ...await load<typeof import("../src/cli/ControlBridge.ts")>(),
  invoke: ports.invoke,
  host: ports.host
}))
vi.mock("../src/cli/Generate.ts", async (load) => ({
  ...await load<typeof import("../src/cli/Generate.ts")>(),
  initialize: ports.initialize
}))
vi.mock("../src/Suggest.ts", async (load) => ({
  ...await load<typeof import("../src/Suggest.ts")>(),
  run: ports.suggest,
  isDirectory: ports.isDirectory
}))

beforeEach(() => {
  ports.invoke.mockReset().mockResolvedValue({ result: "invoked" })
  ports.host.mockReset().mockResolvedValue({ result: "hosting" })
  ports.initialize.mockReset().mockResolvedValue({ result: "initialized" })
  ports.suggest.mockReset().mockReturnValue(Effect.succeed({ status: "listed", implemented: [] }))
  ports.isDirectory.mockReset().mockReturnValue(true)
})

const invoke = async (args: Array<string>, overrides: RuntimeConfig = {}) => {
  const result = { stdout: "", stderr: "", codes: [] as Array<number> }
  const config: RuntimeConfig = {
    environment: {},
    stdout: {
      isTTY: false,
      columns: 80,
      write: (text) => {
        result.stdout += text
      }
    },
    stderr: {
      isTTY: false,
      columns: 80,
      write: (text) => {
        result.stderr += text
      }
    },
    exit: (code) => {
      result.codes.push(code)
    },
    ...overrides
  }
  const presentation = Audience.fromArguments(args, {
    env: config.environment,
    stdout: config.stdout?.isTTY,
    stderr: config.stderr?.isTTY
  })
  const runtime = { ...config, presentation }
  await makeCli(runtime).serve(Audience.incurArguments(args, presentation), {
    env: config.environment,
    stdout: (text) => {
      result.stdout += text
    },
    exit: (code) => {
      result.codes.push(code)
    }
  })
  return { ...result, config: runtime }
}

describe("unified root command dispatch", () => {
  it("keeps help/schema inert across every root command", async () => {
    for (const command of ["init", "doctor", "serve", "gc", "suggest", "migrate", "update", "bug"]) {
      const result = await invoke([command, "--help"])
      expect(result.codes).not.toContain(1)
      expect(result.stdout).toContain(command)
    }
    expect(ports.invoke).not.toHaveBeenCalled()
    expect(ports.host).not.toHaveBeenCalled()
    expect(ports.initialize).not.toHaveBeenCalled()
    expect(ports.suggest).not.toHaveBeenCalled()
  })

  it("passes explicit initialization names, resolved roots and caller environment", async () => {
    const environment = { INIT_MARKER: "caller" }
    const result = await invoke(["init", "sample", "--root", "relative-project", "--json"], { environment })
    expect(ports.initialize).toHaveBeenCalledExactlyOnceWith(resolve("relative-project"), "sample", environment)
    const output = JSON.parse(result.stdout)
    expect(output).toMatchObject({ result: "initialized" })
    expect(output.cta.commands.map((action: { command: string }) => action.command)).toEqual([
      "smthrs targets --root relative-project",
      "smthrs flow list --root relative-project"
    ])
    expect(result.codes).not.toContain(1)
  })

  it("derives omitted initialization arguments from the current project", async () => {
    await invoke(["init", "--json"], { environment: undefined })
    expect(ports.initialize).toHaveBeenCalledExactlyOnceWith(process.cwd(), expect.any(String), process.env)
    expect(ports.initialize.mock.calls[0]![1].length).toBeGreaterThan(0)
  })

  it.each(["doctor", "update"])("routes %s with explicit connection options", async (command) => {
    const result = await invoke([command, "--root", "/fixture", "--quiet", "--json"])
    expect(ports.invoke).toHaveBeenCalledExactlyOnceWith([command], { root: "/fixture", quiet: true }, result.config)
    const output = JSON.parse(result.stdout)
    expect(output).toMatchObject({ result: "invoked" })
    expect(output.cta?.commands.map((action: { command: string }) => action.command) ?? [])
      .toEqual(command === "doctor" ? ["smthrs info --root /fixture"] : [])
  })

  it("starts hosting with explicit connection credentials before environment fallback", async () => {
    const result = await invoke([
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--listen",
      "--credential",
      "explicit-fixture",
      "--json"
    ], { environment: { SMITHERS_API_KEY: "environment-fixture" } })
    expect(ports.host).toHaveBeenCalledExactlyOnceWith(
      { host: "127.0.0.1", port: 0, listen: true, credential: "explicit-fixture" },
      expect.objectContaining({ credential: "explicit-fixture", port: 0, listen: true }),
      result.config
    )
    expect(JSON.parse(result.stdout)).toEqual({ result: "hosting" })
  })

  it("uses the supplied environment credential and binding defaults", async () => {
    await invoke(["serve", "--json"], { environment: { SMITHERS_API_KEY: "environment-fixture" } })
    expect(ports.host.mock.calls[0]![0]).toMatchObject({ credential: "environment-fixture", listen: false })
    expect(ports.host.mock.calls[0]![0].port).toBeGreaterThan(0)
  })

  it.each(["-1", "65536", "1.5"])("rejects invalid port %s before acquiring a host", async (port) => {
    const result = await invoke(["serve", `--port=${port}`, "--json"])
    expect(result.codes.some((code) => code !== 0)).toBe(true)
    expect(ports.host).not.toHaveBeenCalled()
  })

  it.each([false, true])("preserves garbage collection cutoff and dry-run=%s", async (dryRun) => {
    const result = await invoke([
      "gc",
      "--root",
      "/fixture",
      "--older-than",
      "12h",
      ...(dryRun ? ["--dry-run"] : []),
      "--json"
    ])
    expect(ports.invoke).toHaveBeenCalledExactlyOnceWith(
      ["gc", "--older-than", "12h", ...(dryRun ? ["--dry-run"] : [])],
      expect.objectContaining({ olderThan: "12h", dryRun }),
      result.config
    )
  })

  it.each(["gc", "migrate"])("refuses remote %s before dispatch", async (command) => {
    const result = await invoke([command, "--remote", "https://fixture.invalid", "--json"])
    expect(result.codes).toContain(1)
    expect(result.stdout).toContain("requires the host")
    expect(ports.invoke).not.toHaveBeenCalled()
  })

  it("translates migration booleans, numbers, repeated lists and names without forwarding connection flags twice", async () => {
    const result = await invoke([
      "migrate",
      "/source",
      "--root",
      "/workspace",
      "--scan",
      "--allow-no-vcs",
      "--max-repair-rounds",
      "0",
      "--report-dir",
      "/reports",
      "--verify-typecheck",
      "tsc --noEmit",
      "--verify-typecheck",
      "tsc -p test",
      "--json"
    ])
    const args = ports.invoke.mock.calls[0]![0] as Array<string>
    expect(args.slice(0, 2)).toEqual(["migrate", "/source"])
    expect(args).toContain("--scan")
    expect(args).toContain("--allow-no-vcs")
    expect(args.slice(args.indexOf("--max-repair-rounds"), args.indexOf("--max-repair-rounds") + 2)).toEqual([
      "--max-repair-rounds",
      "0"
    ])
    expect(args.slice(args.indexOf("--report-dir"), args.indexOf("--report-dir") + 2)).toEqual([
      "--report-dir",
      "/reports"
    ])
    expect(args.filter((argument) => argument === "--verify-typecheck")).toHaveLength(2)
    expect(args).toContain("tsc --noEmit")
    expect(args).toContain("tsc -p test")
    expect(args).not.toContain("--root")
    expect(args).not.toContain("--apply")
    expect(ports.invoke.mock.calls[0]![1]).toMatchObject({ root: "/workspace", scan: true })
    expect(result.codes).not.toContain(1)
  })

  it("supports migration defaults without inventing a positional path", async () => {
    await invoke(["migrate", "--json"])
    expect(ports.invoke.mock.calls[0]![0]).toEqual(["migrate"])
  })

  it.each([undefined, "run-123"])("preserves bug summary words and optional run attribution (%s)", async (run) => {
    await invoke(["bug", "first", "second", ...(run === undefined ? [] : ["--run", run]), "--json"])
    expect(ports.invoke.mock.calls[0]![0]).toEqual([
      "bug",
      "first",
      "second",
      ...(run === undefined ? [] : ["--run", run])
    ])
  })

  it("redacts bridge failure credentials in structured command errors", async () => {
    ports.invoke.mockRejectedValue(new Error("Authorization: Bearer private-fixture"))
    const result = await invoke(["doctor", "--json"])
    expect(result.codes).toContain(1)
    expect(result.stdout).toContain("[REDACTED_TOKEN]")
    expect(result.stdout + result.stderr).not.toContain("private-fixture")
  })

  it("refuses a non-directory suggestion path before constructing the agent task", async () => {
    ports.isDirectory.mockReturnValue(false)
    const result = await invoke(["suggest", "./missing", "--json"])
    expect(result.codes).toContain(2)
    expect(result.stdout).toContain("must be a directory")
    expect(ports.suggest).not.toHaveBeenCalled()
  })

  it("collects structured suggestion documents in order and preserves cancellation exit status", async () => {
    ports.suggest.mockImplementation((options: Suggest.Options) =>
      Effect.sync(() => {
        options.emit?.(JSON.stringify({ document: "suggestion", id: "first" }))
        options.emit?.(JSON.stringify({ document: "outcome", status: "cancelled" }))
        return { status: "cancelled", implemented: [] }
      })
    )
    const result = await invoke(["suggest", "./fixture", "--list", "--seat", "fixture:model", "--json"])
    expect(ports.suggest.mock.calls[0]![0]).toMatchObject({
      root: resolve("fixture"),
      list: true,
      seat: "fixture:model",
      json: true
    })
    expect(JSON.parse(result.stdout)).toEqual({
      status: "cancelled",
      implemented: [],
      documents: [{ document: "suggestion", id: "first" }, { document: "outcome", status: "cancelled" }]
    })
    expect(result.codes).toContain(130)
  })

  it("leaves human suggestion output to the task and resolves an omitted path from root", async () => {
    const result = await invoke(["suggest", "--root", "/fixture", "--audience", "human", "--silent"], {
      exit: undefined,
      stdout: { isTTY: true, columns: 80, write: () => {} }
    })
    expect(ports.suggest.mock.calls[0]![0]).toMatchObject({ root: "/fixture", json: false, list: false })
    expect(result.stdout).not.toContain("documents")
  })
})
