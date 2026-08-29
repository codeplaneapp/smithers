/**
 * The bundler runner's process side.
 *
 * The refusal cases run everywhere: they need only the host `node`. The
 * end-to-end cases run the real rsbuild/rspack of an existing installed
 * node_modules tree against the `rsbuild-mini` fixture, because this package
 * deliberately ships no bundler of its own — `S.Bundler.Rspack` runs the
 * *workspace's* bundler. Point `SMTHRS_RSBUILD_MODULES` at any node_modules
 * directory containing `@rsbuild/core` to enable them; without one they skip
 * with a warning rather than faking green.
 */
import * as BundlerTarget from "@smthrs/targets/BundlerTarget"
import * as Effect from "effect/Effect"
import { existsSync } from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { resolveGraph, runBuild } from "../src/RspackRunner.ts"

const fixture = NodePath.join(import.meta.dirname, "fixtures", "rsbuild-mini")

/**
 * A node_modules tree that provides @rsbuild/core. The default is the force
 * reference checkout used by the routing-spine proofs; any workspace with
 * rsbuild installed works.
 */
const modulesSource = process.env["SMTHRS_RSBUILD_MODULES"] ?? "/Users/williamcory/artsy/force/node_modules"
const rsbuildAvailable = existsSync(NodePath.join(modulesSource, "@rsbuild", "core"))
if (!rsbuildAvailable) {
  console.warn(
    `RspackRunner end-to-end tests SKIPPED: no @rsbuild/core under ${modulesSource}; ` +
      "set SMTHRS_RSBUILD_MODULES to a node_modules directory that has it"
  )
}

const flipped = <A>(effect: Effect.Effect<A, { readonly stderr: string }>) => Effect.runPromise(Effect.flip(effect))

describe("refusals", () => {
  it("refuses a workspace that does not provide @rsbuild/core, loudly", async () => {
    const root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-rspack-none-"))
    const scratch = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-rspack-scratch-"))
    try {
      await Fs.writeFile(NodePath.join(root, "package.json"), `{"name":"empty","private":true}\n`)
      await Fs.writeFile(NodePath.join(root, "rsbuild.config.mjs"), "export default {}\n")
      const error = await flipped(resolveGraph(
        { workspaceRoot: root, scratchDirectory: scratch, timeoutMs: 60_000 },
        { configPath: "rsbuild.config.mjs", entries: ["main.ts"], mode: "development" }
      ))
      expect(error.stderr).toContain("does not provide @rsbuild/core")
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
      await Fs.rm(scratch, { recursive: true, force: true })
    }
  }, 120_000)

  it("refuses a relative scratch directory", async () => {
    const error = await flipped(resolveGraph(
      { workspaceRoot: Os.tmpdir(), scratchDirectory: "relative/scratch" },
      { configPath: "rsbuild.config.mjs", entries: ["main.ts"], mode: "development" }
    ))
    expect(error.stderr).toContain("must be absolute")
  })
})

describe.runIf(rsbuildAvailable)("rsbuild-mini end to end", () => {
  let workspace: string
  let scratch: string

  beforeAll(async () => {
    workspace = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-rspack-mini-"))
    scratch = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-rspack-mini-scratch-"))
    await Fs.cp(fixture, workspace, { recursive: true })
    // The fixture runs the linked tree's own bundler, exactly as a real
    // workspace runs its own installed one.
    await Fs.symlink(modulesSource, NodePath.join(workspace, "node_modules"), "dir")
  })

  afterAll(async () => {
    await Fs.rm(workspace, { recursive: true, force: true })
    await Fs.rm(scratch, { recursive: true, force: true })
  })

  const options = () => ({
    workspaceRoot: workspace,
    scratchDirectory: scratch,
    timeoutMs: 300_000
  })

  it("resolves the module graph deterministically and never writes into the workspace dist", async () => {
    const first = await Effect.runPromise(resolveGraph(options(), {
      configPath: "rsbuild.config.mjs",
      entries: ["main.ts"],
      mode: "development"
    }))
    expect(first.files.map((file) => file.path)).toEqual(["src/dep.ts", "src/main.ts"])
    for (const file of first.files) expect(file.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(first.moduleCount).toBeGreaterThanOrEqual(2)
    expect(first.graphDigest).toBe(BundlerTarget.graphDigest(first))
    // Resolution emits into scratch, not the workspace.
    expect(existsSync(NodePath.join(workspace, "dist"))).toBe(false)

    const second = await Effect.runPromise(resolveGraph(options(), {
      configPath: "rsbuild.config.mjs",
      entries: ["main.ts"],
      mode: "development"
    }))
    expect(second.files).toEqual(first.files)
    expect(second.packages).toEqual(first.packages)
    expect(second.graphDigest).toBe(first.graphDigest)
  }, 300_000)

  it("refuses an entry that matches no environment", async () => {
    const error = await flipped(resolveGraph(options(), {
      configPath: "rsbuild.config.mjs",
      entries: ["missing.tsx"],
      mode: "development"
    }))
    expect(error.stderr).toContain("matches no environment")
  }, 300_000)

  it("builds the web environment in development mode and produces the declared outDir", async () => {
    const result = await Effect.runPromise(runBuild(options(), {
      configPath: "rsbuild.config.mjs",
      environment: "web",
      mode: "development",
      env: {},
      outDirs: ["dist"]
    }))
    expect(result.exitCode).toBe(0)
    const produced = await Fs.readdir(NodePath.join(workspace, "dist"), { recursive: true })
    expect(produced.length).toBeGreaterThan(0)
    const bundle = produced.find((name) => String(name).endsWith("index.js"))
    expect(bundle).toBeDefined()
    const text = await Fs.readFile(NodePath.join(workspace, "dist", String(bundle)), "utf8")
    expect(text).toContain("rsbuild-mini")
  }, 300_000)

  it("refuses a green build whose declared outDir was not created", async () => {
    const error = await flipped(runBuild(options(), {
      configPath: "rsbuild.config.mjs",
      environment: "web",
      mode: "development",
      env: {},
      outDirs: ["not-the-dist"]
    }))
    expect(error.stderr).toContain("without creating its declared outDirs")
  }, 300_000)

  it("refuses an environment the config does not declare", async () => {
    const error = await flipped(runBuild(options(), {
      configPath: "rsbuild.config.mjs",
      environment: "server",
      mode: "production",
      env: {},
      outDirs: ["dist"]
    }))
    expect(error.stderr).toContain("is not declared")
  }, 300_000)
})
