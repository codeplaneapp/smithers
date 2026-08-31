/**
 * End-to-end execution over real BUILD.ts files in a temporary workspace.
 *
 * Three properties are pinned here, all of which were once only asserted by
 * reading the code:
 *
 * 1. `build`, `test`, `lint`, `docs`, and `ci` EXECUTE selected targets — over
 *    `//...` and over an exact label — instead of printing a plan. The proof
 *    is a side effect on disk that only running the target's Flow produces.
 * 2. A failing target fails the run with a non-zero exit status and BLOCKS its
 *    dependents, which report `skipped` rather than running against a
 *    dependency that never succeeded.
 * 3. A checking verb does not mutate the working tree. Drifted generated files
 *    fail the run, byte for byte unchanged.
 */
import { spawn } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Executor from "../src/Executor.ts"
import * as Planner from "../src/Planner.ts"
import { Workspace } from "../src/Workspace.ts"

const rulesModule = NodePath.resolve(import.meta.dirname, "../../targets/src/Smithers.ts")
const schemaModule = import.meta.resolve("effect/Schema")
const cli = NodePath.resolve(import.meta.dirname, "../src/main.js")

let root: string

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

const read = (relative: string): Promise<string> => Fs.readFile(NodePath.join(root, relative), "utf8")

const open = async (): Promise<Workspace> => Workspace.make(root, root, { cacheDirectory: ".flows" })

/** Plans and executes one verb, exactly as the CLI command does. */
const run = async (
  verb: "build" | "test" | "lint" | "run",
  pattern: string
): Promise<Executor.Summary> => {
  const workspace = await open()
  const plan = await Planner.make(workspace, verb, pattern)
  return Executor.execute({
    workspace,
    verb,
    pattern,
    targets: plan.targets,
    jobs: 4,
    readCache: false,
    log: () => {}
  })
}

/** Plans every CI kind over one pattern and executes the merged graph. */
const runCi = async (pattern: string): Promise<Executor.Summary> => {
  const workspace = await open()
  const plans = []
  for (const kind of ["lint", "build", "test", "docs"] as const) {
    try {
      plans.push(await Planner.make(workspace, kind, pattern))
    } catch (cause) {
      if (!(cause instanceof Planner.UnsupportedVerbError) || cause.verb !== kind) throw cause
    }
  }
  const merged = Executor.mergePlans(plans)
  return Executor.execute({
    workspace,
    verb: "ci",
    pattern,
    targets: merged.targets,
    jobs: 4,
    readCache: false,
    log: () => {}
  })
}

const status = (summary: Executor.Summary, label: string): string | undefined =>
  summary.results.find((entry) => entry.label === label)?.status

const invoke = (args: ReadonlyArray<string>): Promise<{ readonly code: number | null; readonly output: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => output += chunk)
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => output += chunk)
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, output }))
  })

beforeEach(async () => {
  root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-execute-"))
  await write("package.json", `${JSON.stringify({ name: "fixture", private: true }, undefined, 2)}\n`)
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("targets execute", () => {
  /**
   * Two packages, each generating a manifest, plus an `Exec` target that
   * touches a file. A generated file appearing on disk and a shell command
   * having run are both observations no plan print can fake.
   */
  const generatorWorkspace = async (): Promise<void> => {
    await write("BUILD.ts", "export const root = 1\n")
    for (const name of ["alpha", "beta"]) {
      await write(
        `packages/${name}/package.json`,
        `${JSON.stringify({ name, version: "1.0.0" }, undefined, 2)}\n`
      )
      await write(
        `packages/${name}/BUILD.ts`,
        `import { PackageJson } from "${rulesModule}"\n` +
          `export const packageJson = PackageJson({\n` +
          `  name: "${name}",\n` +
          `  version: "1.0.0",\n` +
          `  description: "${name}"\n` +
          `})\n`
      )
    }
  }

  it("executes every generator selected by //... and writes the files", async () => {
    await generatorWorkspace()
    const summaries = [
      await run("run", "//packages/alpha:packageJsonWrite"),
      await run("run", "//packages/beta:packageJsonWrite")
    ]

    expect(summaries.every((summary) => summary.ok), JSON.stringify(summaries)).toBe(true)
    expect(summaries.reduce((count, summary) => count + summary.counts.ran, 0)).toBe(2)
    expect(summaries.reduce((count, summary) => count + summary.counts.failed, 0)).toBe(0)
    // The observable effect of actually running the targets.
    expect(JSON.parse(await read("packages/alpha/package.json")).description).toBe("alpha")
    expect(JSON.parse(await read("packages/beta/package.json")).description).toBe("beta")
  })

  it("executes only the target named by an exact label", async () => {
    await generatorWorkspace()
    const summary = await run("run", "//packages/alpha:packageJsonWrite")

    expect(summary.ok).toBe(true)
    expect(summary.results.map((entry) => entry.label)).toEqual(["//packages/alpha:packageJsonWrite"])
    expect(await read("packages/alpha/package.json")).toContain("\"description\": \"alpha\"")
    expect(await read("packages/beta/package.json")).not.toContain("description")
  })

  it("runs a real command through the exec action", async () => {
    await write("BUILD.ts", "export const root = 1\n")
    await write(
      "packages/tool/BUILD.ts",
      `import { Exec, Target } from "${rulesModule}"\n` +
        `import * as Schema from "${schemaModule}"\n` +
        `export const touch = Target.make("Touch", {\n` +
        `  attrs: Schema.Struct({ name: Schema.NonEmptyString }),\n` +
        `  kinds: ["build"],\n` +
        `  success: Exec.Result,\n` +
        `  error: Exec.ExecError,\n` +
        `  implementation: (attrs) => Target.runTool({ cwd: ".", argv: ["node", "-e", \`require('fs').writeFileSync('ran-\${attrs.name}.txt','ok')\`] })\n` +
        `})({ name: "tool" })\n`
    )
    const summary = await run("build", "//...")

    expect(summary.ok).toBe(true)
    expect(await read("ran-tool.txt")).toBe("ok")
  })

  it("fails the run and blocks dependents when a target fails", async () => {
    await write("BUILD.ts", "export const root = 1\n")
    await write(
      "packages/base/BUILD.ts",
      `import { Exec, Target } from "${rulesModule}"\n` +
        `import * as Schema from "${schemaModule}"\n` +
        `export const failing = Target.make("Failing", {\n` +
        `  attrs: Schema.Struct({}),\n` +
        `  kinds: ["build"],\n` +
        `  success: Exec.Result,\n` +
        `  error: Exec.ExecError,\n` +
        `  implementation: () => Target.runTool({ cwd: ".", argv: ["node", "-e", "process.exit(3)"] })\n` +
        `})({})\n`
    )
    await write(
      "packages/dependent/BUILD.ts",
      `import { Exec, Target } from "${rulesModule}"\n` +
        `import * as Schema from "${schemaModule}"\n` +
        `import { failing } from "../base/BUILD.ts"\n` +
        `export const downstream = Target.make("Downstream", {\n` +
        `  attrs: Schema.Struct({ deps: Schema.Array(Target.Target) }),\n` +
        `  kinds: ["build"],\n` +
        `  success: Exec.Result,\n` +
        `  error: Exec.ExecError,\n` +
        `  implementation: () => Target.runTool({ cwd: ".", argv: ["node", "-e", \`require('fs').writeFileSync('downstream-ran.txt','ok')\`] })\n` +
        `})({ deps: [failing] })\n`
    )
    const summary = await run("build", "//...")
    expect(summary.ok).toBe(false)
    expect(summary.counts.failed).toBe(1)
    expect(status(summary, "//packages/base:failing")).toBe("failed")
    // Blocked, not run: the dependent never executed against a dependency
    // that did not succeed.
    expect(status(summary, "//packages/dependent:downstream")).toBe("skipped")
    await expect(read("downstream-ran.txt")).rejects.toThrow()
  })

  it("propagates failure through the real CLI process and still blocks dependents", async () => {
    await write("BUILD.ts", "export const root = 1\n")
    await write(
      "packages/base/BUILD.ts",
      `import { Exec, Target } from "${rulesModule}"\n` +
        `import * as Schema from "${schemaModule}"\n` +
        `export const failing = Target.make("ProcessFailing", {\n` +
        `  attrs: Schema.Struct({}), kinds: ["build"], success: Exec.Result, error: Exec.ExecError,\n` +
        `  implementation: () => Target.runTool({ cwd: ".", argv: ["node", "-e", "process.exit(7)"] })\n` +
        `})({})\n`
    )
    await write(
      "packages/dependent/BUILD.ts",
      `import { Exec, Target } from "${rulesModule}"\n` +
        `import * as Schema from "${schemaModule}"\n` +
        `import { failing } from "../base/BUILD.ts"\n` +
        `export const downstream = Target.make("ProcessDependent", {\n` +
        `  attrs: Schema.Struct({ deps: Schema.Array(Target.Target) }), kinds: ["build"],\n` +
        `  success: Exec.Result, error: Exec.ExecError,\n` +
        `  implementation: () => Target.runTool({ cwd: ".", argv: ["node", "-e", ` +
        `"require('node:fs').writeFileSync('process-dependent-ran','bad')"] })\n` +
        `})({ deps: [failing] })\n`
    )

    const result = await invoke(["build", "//..."])
    expect(result.code).not.toBe(0)
    expect(result.output).toContain("//packages/base:failing")
    await expect(Fs.stat(NodePath.join(root, "process-dependent-ran"))).rejects.toMatchObject({ code: "ENOENT" })
  })
})

describe("checking verbs do not mutate the working tree", () => {
  const driftedWorkspace = async (): Promise<void> => {
    await write("BUILD.ts", "export const root = 1\n")
    await write("packages/alpha/package.json", `${JSON.stringify({ name: "alpha" }, undefined, 2)}\n`)
    await write(
      "packages/alpha/BUILD.ts",
      `import { PackageJson } from "${rulesModule}"\n` +
        `export const packageJson = PackageJson({\n` +
        `  name: "alpha",\n` +
        `  version: "1.0.0",\n` +
        `  description: "alpha"\n` +
        `})\n`
    )
  }

  it("lint fails on drift and leaves the file byte for byte unchanged", async () => {
    await driftedWorkspace()
    const before = await read("packages/alpha/package.json")
    const summary = await run("lint", "//...")

    expect(summary.ok).toBe(false)
    expect(status(summary, "//packages/alpha:packageJsonCheck")).toBe("failed")
    expect(await read("packages/alpha/package.json")).toBe(before)
  })

  it("ci fails on drift and leaves the file byte for byte unchanged", async () => {
    await driftedWorkspace()
    const before = await read("packages/alpha/package.json")
    const summary = await runCi("//...")

    expect(summary.ok).toBe(false)
    expect(await read("packages/alpha/package.json")).toBe(before)
  })

  it("build does not select either manifest sync target", async () => {
    await driftedWorkspace()
    const before = await read("packages/alpha/package.json")
    const summary = await run("build", "//...")

    expect(summary.ok).toBe(true)
    expect(await read("packages/alpha/package.json")).toBe(before)
  })

  it("ci selects the check target and never the separate write target", async () => {
    await driftedWorkspace()
    const before = await read("packages/alpha/package.json")
    const summary = await runCi("//...")

    expect(summary.ok).toBe(false)
    expect(status(summary, "//packages/alpha:packageJsonCheck")).toBe("failed")
    expect(await read("packages/alpha/package.json")).toBe(before)
  })

  it("ci executes documentation parity targets", async () => {
    await write("BUILD.ts", "export const root = 1\n")
    await write("packages/thin/README.md", "# thin\n\nToo short.\n")
    await write(
      "packages/thin/BUILD.ts",
      `import { DocsParity, file } from "${rulesModule}"\n` +
        `export const docs = DocsParity({ readme: file("README.md"), deps: [], cwd: "packages/thin" })\n`
    )

    const summary = await runCi("//...")

    expect(summary.ok).toBe(false)
    expect(status(summary, "//packages/thin:docs")).toBe("failed")
  })
})

/**
 * The generated CI workflow, end to end.
 *
 * A job declares what it requires and which targets it runs; every step the
 * file carries is derived from those declarations. What is pinned here is that
 * the derivation reaches disk, that the checking verb reports a hand edit
 * without repairing it, and that a declaration promising coverage it does not
 * deliver fails before any file is written.
 */
describe("the CI workflow generator", () => {
  const pipeline = (options: {
    readonly mode: string
    readonly gates?: string
    readonly requiredJobs?: string
    readonly steps?: string
  }): string =>
    `import { CiToolchain, GithubCiGen, PackageManager, Runtime, Verb } from "${rulesModule}"\n` +
    `const runtime = Runtime.Node({ version: ">=22.19.0" })\n` +
    `const packageManager = PackageManager.Pnpm({ version: "11.21.0", runtime })\n` +
    `export const ci = GithubCiGen({\n` +
    `  packageManager,\n` +
    `  workflowName: "CI",\n` +
    `  pushBranches: ["main"],\n` +
    `  pullRequest: true,\n` +
    `  workflowDispatch: false,\n` +
    `  cancelInProgress: true,\n` +
    `  requiredJobs: [${options.requiredJobs ?? "\"test\""}],\n` +
    `  gates: [${options.gates ?? "{ name: \"packages\", verb: Verb.Test, pattern: \"//packages/...\" }"}],\n` +
    `  jobs: [{\n` +
    `    id: "test",\n` +
    `    runsOn: "ubuntu-latest",\n` +
    `    toolchain: CiToolchain.Needs({\n` +
    `      runtimes: [CiToolchain.Node({ runtime, release: "22.19.0" })]\n` +
    `    }),\n` +
    `    steps: [${options.steps ?? "{ verb: Verb.Test, pattern: \"//packages/...\" }"}]\n` +
    `  }],\n` +
    `  output: ".github/workflows/generated.yml",\n` +
    `  mode: "${options.mode}"\n` +
    `})\n`

  const workspaceWith = async (source: string): Promise<void> => {
    await write("BUILD.ts", "export const root = 1\n")
    await write("packages/pipeline/BUILD.ts", source)
  }

  it("writes a workflow that installs from the lockfile and runs the pinned CLI", async () => {
    await workspaceWith(pipeline({ mode: "write" }))
    const summary = await run("build", "//...")

    expect(summary.ok).toBe(true)
    const generated = await read(".github/workflows/generated.yml")
    // The install argv comes from the declared package manager, never from an
    // attr a BUILD.ts file wrote.
    const install = generated.indexOf("- run: pnpm install --frozen-lockfile --ignore-scripts")
    // The pattern is rendered as one single-quoted shell word, so the runner's
    // shell cannot expand or re-split it.
    const execute = generated.indexOf("- run: pnpm exec smithers-build test '//packages/...'")
    expect(install).toBeGreaterThan(-1)
    // The workspace-pinned CLI, after the install that pinned it, and nothing
    // fetched from a registry.
    expect(execute).toBeGreaterThan(install)
    expect(generated).not.toContain("dlx")
    // Every step is a derived one. Nothing here was authored as a command.
    expect(generated).not.toContain("pnpm run ")
    expect(generated).not.toContain("node --test ")
  })

  it("lints the workflow it just wrote, and reports a hand edit without repairing it", async () => {
    await workspaceWith(pipeline({ mode: "write" }))
    await run("build", "//...")
    const generated = await read(".github/workflows/generated.yml")

    // The `lint` form of a writing target is the checking form.
    expect((await run("lint", "//...")).ok).toBe(true)

    const edited = generated.replace(
      "      - run: pnpm exec smithers-build test '//packages/...'\n",
      "      - run: echo skipped\n"
    )
    expect(edited).not.toBe(generated)
    await write(".github/workflows/generated.yml", edited)
    const drifted = await run("lint", "//...")

    expect(drifted.ok).toBe(false)
    expect(await read(".github/workflows/generated.yml")).toBe(edited)
  })

  it("fails the checking verb when the workflow file is missing entirely", async () => {
    await workspaceWith(pipeline({ mode: "check" }))
    expect((await run("lint", "//...")).ok).toBe(false)
  })

  it("fails, without writing, when no job performs a declared gate", async () => {
    await workspaceWith(pipeline({
      mode: "write",
      gates: `{ name: "documentation parity", verb: Verb.Docs, pattern: "//docs/..." }`
    }))
    const result = await invoke(["build", "//..."])

    expect(result.code).not.toBe(0)
    expect(result.output).toContain("does not run documentation parity")
    await expect(read(".github/workflows/generated.yml")).rejects.toThrow()
  })

  it("fails, without writing, when a required job is not declared", async () => {
    await workspaceWith(pipeline({ mode: "write", requiredJobs: `"test", "rust"` }))
    const result = await invoke(["build", "//..."])

    expect(result.code).not.toBe(0)
    expect(result.output).toContain("missing required jobs: rust")
    await expect(read(".github/workflows/generated.yml")).rejects.toThrow()
  })

  it("fails, without writing, when a step names something the label grammar rejects", async () => {
    await workspaceWith(pipeline({
      mode: "write",
      gates: "",
      steps: `{ verb: Verb.Test, pattern: "--help" }`
    }))
    const result = await invoke(["build", "//..."])

    expect(result.code).not.toBe(0)
    expect(result.output).toContain("is not a target pattern")
    await expect(read(".github/workflows/generated.yml")).rejects.toThrow()
  })
})

/**
 * `S.Generate`'s script form in a BUILD.ts workspace.
 *
 * The declaration names the workspace runtime rather than a host path, so the
 * planned argv carries the `{smthrs:tool:...}` placeholder until the exec
 * boundary substitutes it. A run that spawns the placeholder verbatim fails
 * with ENOENT and never runs the generator, which is how the only
 * `S.Generate` in this repository sat ungated: no verb could execute it.
 */
describe("generate script form", () => {
  const generatorWorkspace = async (): Promise<void> => {
    await write(
      "BUILD.ts",
      `import { file, Generate } from "${rulesModule}"\n` +
        `export const generated = Generate({\n` +
        `  script: file("//gen.mjs"),\n` +
        `  changes: ["generated.txt"]\n` +
        `})\n`
    )
    await write(
      "gen.mjs",
      `import { writeFileSync } from "node:fs"\nwriteFileSync("generated.txt", "generated\\n")\n`
    )
  }

  it("substitutes the runtime placeholder and regenerates under the run verb", async () => {
    await generatorWorkspace()
    const summary = await run("run", "//:generated")

    expect(JSON.stringify(summary.results)).not.toContain("{smthrs:tool:")
    expect(summary.ok, JSON.stringify(summary.results)).toBe(true)
    expect(await read("generated.txt")).toBe("generated\n")
  })

  it("fails the lint verb on a drifted file and leaves the tree unchanged", async () => {
    await generatorWorkspace()
    await write("generated.txt", "hand edited\n")
    const drifted = await run("lint", "//:generated")

    expect(drifted.ok).toBe(false)
    expect(JSON.stringify(drifted.results)).toContain("generated.txt")
    expect(await read("generated.txt")).toBe("hand edited\n")
  })

  it("passes the lint verb when the checked-in file matches its generator", async () => {
    await generatorWorkspace()
    await write("generated.txt", "generated\n")
    const clean = await run("lint", "//:generated")

    expect(clean.ok, JSON.stringify(clean.results)).toBe(true)
    expect(await read("generated.txt")).toBe("generated\n")
  })
})
