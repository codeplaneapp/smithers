/**
 * The cache's trust boundaries, exercised end to end in a real workspace.
 *
 * Every case here is a way a green report can be a lie. A cache entry is
 * untrusted input: it may have been written by another workspace, hydrated
 * from a shared remote, restored from a backup, or hand edited. A tool's own
 * success payload is untrusted too, because an implementation can return
 * without producing what its target declared. And the tree the plan measured can
 * change before the executor acts on that measurement.
 *
 * The properties pinned:
 *
 * 1. An entry answers only for the action that produced it — same key, same
 *    target, same label.
 * 2. A target that declares outputs is admitted, and reported green, only
 *    against an exact manifest that measurement agrees with.
 * 3. A declared input that changed between the plan and the act fails the
 *    target instead of being cached or replayed under a stale key.
 */
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { decodeCacheOutput, encodeCacheOutput } from "../src/Executor.ts"
import * as Executor from "../src/Executor.ts"
import * as Planner from "../src/Planner.ts"
import { Workspace } from "../src/Workspace.ts"

const rulesModule = NodePath.resolve(import.meta.dirname, "../../targets/src/Smithers.ts")
const schemaModule = import.meta.resolve("effect/Schema")
const nodeModule = import.meta.resolve("@smthrs/plan/Node")

let root: string

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

/**
 * One cacheable `ToolBuild` target: `program` is the body of a `node -e` run,
 * `src/input.txt` is the declared input, and `out` is the declared output.
 */
const toolWorkspace = async (program: string): Promise<void> => {
  await write("package.json", `${JSON.stringify({ name: "fixture", private: true }, undefined, 2)}\n`)
  await write("src/input.txt", "source\n")
  await write(
    "BUILD.ts",
    `import { file, ToolBuild } from "${rulesModule}"\n` +
      `export const build = ToolBuild({\n` +
      `  tool: "node",\n` +
      `  command: "node",\n` +
      `  args: ["-e", ${JSON.stringify(program)}],\n` +
      `  inputs: [file("//src/input.txt")],\n` +
      `  outputs: ["out"],\n` +
      `  deps: [],\n` +
      `  env: {},\n` +
      `  cache: true,\n` +
      `  cwd: "."\n` +
      `})\n`
  )
}

const producing = "require('node:fs').writeFileSync('out', 'produced')"

const open = (): Promise<Workspace> => Workspace.make(root, root, { cacheDirectory: ".flows" })

const plan = async (): Promise<{
  readonly workspace: Workspace
  readonly targets: ReadonlyArray<Planner.PlannedTarget>
}> => {
  const workspace = await open()
  const made = await Planner.make(workspace, "build", "//...")
  return { workspace, targets: made.targets }
}

const runPlan = async (
  prepared: { readonly workspace: Workspace; readonly targets: ReadonlyArray<Planner.PlannedTarget> },
  readCache = true
): Promise<Executor.Summary> =>
  Executor.execute({
    workspace: prepared.workspace,
    verb: "build",
    pattern: "//...",
    targets: prepared.targets,
    jobs: 2,
    readCache,
    log: () => {}
  })

/** Plans and executes `build` over the whole workspace, as the CLI does. */
const run = async (readCache = true): Promise<Executor.Summary> => runPlan(await plan(), readCache)

/** Every entry file the local cache holds. */
const entryFiles = async (): Promise<ReadonlyArray<string>> => {
  const directory = NodePath.join(root, ".flows/cache")
  const found: Array<string> = []
  const visit = async (relative: string): Promise<void> => {
    for (const entry of await Fs.readdir(NodePath.join(directory, relative), { withFileTypes: true }).catch(() => [])) {
      const child = NodePath.join(relative, entry.name)
      if (entry.isDirectory()) await visit(child)
      else found.push(NodePath.join(directory, child))
    }
  }
  await visit("")
  return found.sort()
}

/** Rewrites the single stored entry through `edit`. */
const poison = async (edit: (entry: Record<string, unknown>) => Record<string, unknown>): Promise<void> => {
  const files = await entryFiles()
  expect(files).toHaveLength(1)
  const stored = JSON.parse(await Fs.readFile(files[0]!, "utf8")) as Record<string, unknown>
  await Fs.writeFile(files[0]!, JSON.stringify(edit(stored)), "utf8")
}

/** Reads and replaces the value inside the executor's unambiguous cache envelope. */
const cachedValue = (entry: Record<string, unknown>): unknown => {
  const decoded = decodeCacheOutput(entry["output"])
  if (!("value" in decoded)) throw new Error(decoded.reason)
  return decoded.value
}

const withCachedValue = (entry: Record<string, unknown>, value: unknown): Record<string, unknown> => {
  const encoded = encodeCacheOutput(value)
  if (!("output" in encoded)) throw new Error(encoded.reason)
  return { ...entry, output: encoded.output }
}

beforeEach(async () => {
  root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-trust-"))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("an entry answers only for the action that produced it", () => {
  it("hits its own entry", async () => {
    await toolWorkspace(producing)
    expect((await run()).counts.ran).toBe(1)
    const second = await run()
    expect(second.counts.hit).toBe(1)
    expect(second.counts.ran).toBe(0)
  })

  /**
   * The gap: admission checked the key and nothing else. An entry filed under
   * the right key but naming another target was replayed as this target's result,
   * which is exactly what a shared or hostile store gets to arrange. The target
   * and the label are now part of admission.
   */
  it.each([
    ["target", (entry: Record<string, unknown>) => ({ ...entry, target: "SomeOtherRule" })],
    ["label", (entry: Record<string, unknown>) => ({ ...entry, label: "//elsewhere:target" })]
  ])("re-executes rather than admitting an entry naming another %s", async (_name, edit) => {
    await toolWorkspace(producing)
    expect((await run()).counts.ran).toBe(1)
    await poison(edit)

    const second = await run()
    expect(second.counts.hit).toBe(0)
    expect(second.counts.ran).toBe(1)
  })

  it("never replays a stored red result", async () => {
    await toolWorkspace(producing)
    await run()
    await poison((entry) => ({ ...entry, exitOk: false }))
    expect((await run()).counts.hit).toBe(0)
  })

  it("re-executes when an output-less entry fails the target's success schema", async () => {
    await write("package.json", `${JSON.stringify({ name: "fixture", private: true }, undefined, 2)}\n`)
    await write(
      "BUILD.ts",
      `import { Target } from "${rulesModule}"\n` +
        `import * as Node from "${nodeModule}"\n` +
        `import * as Schema from "${schemaModule}"\n` +
        `export const build = Target.make("TypedSuccess", {\n` +
        `  attrs: Schema.Struct({}),\n` +
        `  kinds: ["build"],\n` +
        `  success: Schema.Struct({ value: Schema.Number }),\n` +
        `  cache: true,\n` +
        `  implementation: () => Node.succeed({ value: 1 })\n` +
        `})({})\n`
    )
    expect((await run()).counts.ran).toBe(1)
    await poison((entry) => withCachedValue(entry, { value: "forged" }))

    const second = await run()
    expect(second.counts.hit).toBe(0)
    expect(second.counts.ran).toBe(1)
  })
})

describe("a declared output tree is verified exactly", () => {
  const cases: ReadonlyArray<readonly [string, (entry: Record<string, unknown>) => Record<string, unknown>]> = [
    [
      "an entry carrying no manifest at all",
      (entry) => withCachedValue(entry, { ok: true })
    ],
    [
      "an entry whose manifest is empty",
      (entry) => withCachedValue(entry, { outputs: [] })
    ],
    [
      "an entry whose manifest is not a list",
      (entry) => withCachedValue(entry, { outputs: "out" })
    ],
    [
      "an entry with an extra output",
      (entry) => {
        const outputs = (cachedValue(entry) as { outputs: ReadonlyArray<unknown> }).outputs
        return withCachedValue(entry, { outputs: [...outputs, ...outputs] })
      }
    ],
    [
      "an entry whose output path was forged",
      (entry) => {
        const [first] = (cachedValue(entry) as { outputs: ReadonlyArray<Record<string, unknown>> }).outputs
        return withCachedValue(entry, { outputs: [{ ...first, path: "src" }] })
      }
    ],
    [
      "an entry whose file count is not an integer",
      (entry) => {
        const [first] = (cachedValue(entry) as { outputs: ReadonlyArray<Record<string, unknown>> }).outputs
        return withCachedValue(entry, { outputs: [{ ...first, fileCount: 1.5 }] })
      }
    ],
    [
      "an entry whose file count is negative",
      (entry) => {
        const [first] = (cachedValue(entry) as { outputs: ReadonlyArray<Record<string, unknown>> }).outputs
        return withCachedValue(entry, { outputs: [{ ...first, fileCount: -1 }] })
      }
    ],
    [
      "an entry whose digest is not a digest",
      (entry) => {
        const [first] = (cachedValue(entry) as { outputs: ReadonlyArray<Record<string, unknown>> }).outputs
        return withCachedValue(entry, { outputs: [{ ...first, contentDigest: "trust me" }] })
      }
    ],
    [
      "an entry whose digest belongs to another tree",
      (entry) => {
        const [first] = (cachedValue(entry) as { outputs: ReadonlyArray<Record<string, unknown>> }).outputs
        return withCachedValue(entry, { outputs: [{ ...first, contentDigest: "f".repeat(64) }] })
      }
    ],
    [
      "an entry whose output is recorded as a bare string",
      (entry) => withCachedValue(entry, { outputs: ["out"] })
    ]
  ]

  it.each(cases)("re-executes rather than admitting %s", async (_name, edit) => {
    await toolWorkspace(producing)
    expect((await run()).counts.ran).toBe(1)
    await poison(edit)

    const second = await run()
    expect(second.counts.hit).toBe(0)
    expect(second.counts.ran).toBe(1)
    expect(second.ok).toBe(true)
  })

  /**
   * The specific hole this closes: `cachedOutputsAreValid` returned true for
   * any entry with no `outputs` member and otherwise validated exactly the
   * paths the entry itself listed. An entry could therefore claim a build
   * whose `dist` was never produced, or list one cheap path and omit the rest,
   * and be admitted. The declaration now comes from target metadata, so the
   * entry has no say in what gets measured.
   */
  it("re-executes when a declared output was deleted after the entry was stored", async () => {
    await toolWorkspace(producing)
    await run()
    await Fs.rm(NodePath.join(root, "out"))

    const second = await run()
    expect(second.counts.hit).toBe(0)
    expect(second.counts.ran).toBe(1)
    expect(await Fs.readFile(NodePath.join(root, "out"), "utf8")).toBe("produced")
  })

  /**
   * A target that declares outputs and returns success without a manifest is a
   * broken producer, not a green target. Nothing about the tool run proves the
   * outputs exist, so the target fails and nothing is cached.
   */
  it("fails a producing target whose implementation returns no manifest", async () => {
    await write("package.json", `${JSON.stringify({ name: "fixture", private: true }, undefined, 2)}\n`)
    await write(
      "BUILD.ts",
      `import { Exec, Target } from "${rulesModule}"\n` +
        `import * as Schema from "${schemaModule}"\n` +
        // Declares `out`, runs a tool that creates it, and never captures it.
        `export const build = Target.make("Unmanifested", {\n` +
        `  attrs: Schema.Struct({}),\n` +
        `  kinds: ["build"],\n` +
        `  success: Exec.Result,\n` +
        `  error: Exec.ExecError,\n` +
        `  outputs: () => ({ cwd: ".", paths: ["out"] }),\n` +
        `  implementation: () => Target.runTool({ cwd: ".", argv: ["node", "-e", ` +
        `"require('node:fs').writeFileSync('out','produced')"] })\n` +
        `})({})\n`
    )

    const summary = await run()

    expect(summary.ok).toBe(false)
    expect(summary.counts.failed).toBe(1)
    expect(summary.counts.ran).toBe(0)
    expect(summary.results[0]!.error).toContain("no output manifest")
    expect(await entryFiles()).toEqual([])
  })

  it("does not force a target that declares no outputs to carry a manifest", async () => {
    await write("package.json", `${JSON.stringify({ name: "fixture", private: true }, undefined, 2)}\n`)
    await write(
      "BUILD.ts",
      `import { Exec, Target, file } from "${rulesModule}"\n` +
        `import * as Schema from "${schemaModule}"\n` +
        `export const build = Target.make("NoOutputs", {\n` +
        `  attrs: Schema.Struct({ srcs: Schema.Array(Schema.Any) }),\n` +
        `  kinds: ["build"],\n` +
        `  success: Exec.Result,\n` +
        `  error: Exec.ExecError,\n` +
        `  cache: true,\n` +
        `  implementation: () => Target.runTool({ cwd: ".", argv: ["node", "-e", "0"] })\n` +
        `})({ srcs: [file("//src/input.txt")] })\n`
    )
    await write("src/input.txt", "source\n")

    expect((await run()).counts.ran).toBe(1)
    const second = await run()
    expect(second.counts.hit).toBe(1)
    expect(second.ok).toBe(true)
  })
})

describe("a plan's input measurement is revalidated before it is acted on", () => {
  /**
   * The window: the planner measured `src/input.txt` and derived a key from
   * it. Anything that happens between then and the executor's decision makes
   * that key describe a tree that no longer exists. Answering a hit under it,
   * or publishing a fresh result under it, poisons the cache for every later
   * run of the real content.
   */
  it("fails the target when a declared input changed before the cache lookup", async () => {
    await toolWorkspace(producing)
    await run()
    const before = await entryFiles()

    const prepared = await plan()
    // The plan is made. The tree moves. The plan is then executed.
    await write("src/input.txt", "edited after planning\n")
    const summary = await runPlan(prepared)

    expect(summary.ok).toBe(false)
    expect(summary.counts.hit).toBe(0)
    expect(summary.counts.failed).toBe(1)
    expect(summary.results[0]!.error).toContain("changed since the plan was made")
    // No new entry, and the old one was not overwritten under the stale key.
    expect(await entryFiles()).toEqual(before)
  })

  it("blocks dependents and keeps unrelated targets running", async () => {
    await write("package.json", `${JSON.stringify({ name: "fixture", private: true }, undefined, 2)}\n`)
    await write("BUILD.ts", "export const root = 1\n")
    await write("packages/base/src/input.txt", "source\n")
    await write(
      "packages/base/BUILD.ts",
      `import { file, ToolBuild } from "${rulesModule}"\n` +
        `export const base = ToolBuild({\n` +
        `  tool: "node", command: "node", args: ["-e", "require('node:fs').writeFileSync('out','ok')"],\n` +
        `  inputs: [file("//packages/base/src/input.txt")], outputs: ["out"], deps: [], env: {},\n` +
        `  cache: true, cwd: "packages/base"\n` +
        `})\n`
    )
    await write(
      "packages/dependent/BUILD.ts",
      `import { ToolBuild } from "${rulesModule}"\n` +
        `import { base } from "../base/BUILD.ts"\n` +
        `export const downstream = ToolBuild({\n` +
        `  tool: "node", command: "node", args: ["-e", "require('node:fs').writeFileSync('out','ok')"],\n` +
        `  inputs: [], outputs: ["out"], deps: [base], env: {}, cache: true, cwd: "packages/dependent"\n` +
        `})\n`
    )
    await write(
      "packages/other/BUILD.ts",
      `import { ToolBuild } from "${rulesModule}"\n` +
        `export const other = ToolBuild({\n` +
        `  tool: "node", command: "node", args: ["-e", "require('node:fs').writeFileSync('out','ok')"],\n` +
        `  inputs: [], outputs: ["out"], deps: [], env: {}, cache: true, cwd: "packages/other"\n` +
        `})\n`
    )
    await Fs.mkdir(NodePath.join(root, "packages/dependent"), { recursive: true })
    await Fs.mkdir(NodePath.join(root, "packages/other"), { recursive: true })

    const prepared = await plan()
    await write("packages/base/src/input.txt", "edited after planning\n")
    const summary = await runPlan(prepared)

    const status = (label: string): string | undefined => summary.results.find((entry) => entry.label === label)?.status
    expect(status("//packages/base:base")).toBe("failed")
    // Ordinary keep-going semantics: the cone is blocked, the rest still runs.
    expect(status("//packages/dependent:downstream")).toBe("skipped")
    expect(status("//packages/other:other")).toBe("ran")
    expect(summary.ok).toBe(false)
  })

  /**
   * A deterministic seam for the during-execution case: the tool itself
   * rewrites the file the target declared as an input. The change lands inside
   * the execution window every time, with no timer and no latch to tune. The
   * result is green from the tool's point of view and must still not be
   * published, because it was produced from content the key does not describe.
   */
  it("fails the target when a declared input changes during execution", async () => {
    await toolWorkspace(
      "const fs = require('node:fs');" +
        "fs.writeFileSync('src/input.txt', 'rewritten by the tool');" +
        "fs.writeFileSync('out', 'produced')"
    )

    const summary = await run()

    expect(summary.ok).toBe(false)
    expect(summary.counts.ran).toBe(0)
    expect(summary.counts.failed).toBe(1)
    expect(summary.results[0]!.error).toContain("changed since the plan was made")
    expect(await entryFiles()).toEqual([])
  })

  it("fails the target when a declared input can no longer be read", async () => {
    if (process.getuid?.() === 0) return
    await toolWorkspace(producing)
    const prepared = await plan()
    const input = NodePath.join(root, "src/input.txt")
    await Fs.chmod(input, 0o000)
    try {
      const summary = await runPlan(prepared)
      expect(summary.ok).toBe(false)
      expect(summary.results[0]!.error).toContain("could not be revalidated")
      expect(await entryFiles()).toEqual([])
    } finally {
      await Fs.chmod(input, 0o600).catch(() => undefined)
    }
  })

  it("compares paths and digests, not only how many files matched", async () => {
    // A glob that lost one file and gained another has the same length and a
    // different meaning. Length-only comparison called this unchanged.
    await write("package.json", `${JSON.stringify({ name: "fixture", private: true }, undefined, 2)}\n`)
    await write("src/a.txt", "a\n")
    await write("src/b.txt", "b\n")
    await write(
      "BUILD.ts",
      `import { glob, ToolBuild } from "${rulesModule}"\n` +
        `export const build = ToolBuild({\n` +
        `  tool: "node", command: "node", args: ["-e", "require('node:fs').writeFileSync('out','ok')"],\n` +
        `  inputs: [glob("src/*.txt")], outputs: ["out"], deps: [], env: {}, cache: true, cwd: "."\n` +
        `})\n`
    )

    const prepared = await plan()
    await Fs.rm(NodePath.join(root, "src/b.txt"))
    await write("src/c.txt", "b\n")
    const summary = await runPlan(prepared)

    expect(summary.ok).toBe(false)
    expect(summary.results[0]!.error).toMatch(/changed|different set of files/)
  })
})

describe("only a value that round trips is cached", () => {
  it.each([
    ["undefined, which a Void success carries", undefined],
    ["null", null],
    ["a plain record", { a: 1, b: [true, "x"] }]
  ])("stores %s without confusing it with another JSON value", (_name, value) => {
    const encoded = encodeCacheOutput(value)
    expect(encoded).toHaveProperty("output")
    if (!("output" in encoded)) throw new Error(encoded.reason)
    expect(decodeCacheOutput(encoded.output)).toEqual({ value })
  })

  /**
   * The regression: an unserializable success was caught and cached as the
   * JSON value `null`, so every later run answered that action with `null` as
   * though it were the recorded result. The lossy-but-not-throwing conversions
   * were worse, because nothing signalled them at all.
   */
  it.each([
    ["a cycle", () => {
      const cyclic: Record<string, unknown> = {}
      cyclic["self"] = cyclic
      return cyclic
    }],
    ["a nested undefined", () => ({ value: undefined })],
    ["NaN", () => ({ value: Number.NaN })],
    ["Infinity", () => ({ value: Number.POSITIVE_INFINITY })],
    ["a bigint", () => ({ value: 1n })],
    ["a function", () => ({ value: () => 1 })],
    ["a symbol", () => ({ value: Symbol("s") })],
    ["a Date", () => ({ value: new Date(0) })],
    ["a Map", () => ({ value: new Map([["a", 1]]) })],
    ["a class instance", () => ({
      value: new (class Holder {
        readonly a = 1
      })()
    })],
    ["a sparse array", () => ({ value: [1, , 3] })],
    ["negative zero", () => -0],
    ["an array with an extra own property", () => Object.assign([1], { extra: 2 })],
    ["a symbol-keyed property", () => ({ [Symbol.for("smthrs/test")]: 1 })],
    ["a non-enumerable property", () => {
      const value = { visible: 1 }
      Object.defineProperty(value, "hidden", { value: 2, enumerable: false })
      return value
    }],
    ["a Proxy", () => new Proxy({ value: 1 }, {})]
  ])("refuses to store %s", (_name, build) => {
    const encoded = encodeCacheOutput(build())
    expect(encoded).not.toHaveProperty("output")
    expect((encoded as { readonly reason: string }).reason).not.toBe("")
  })

  it("refuses an accessor without invoking it", () => {
    let calls = 0
    const value = {}
    Object.defineProperty(value, "secret", {
      enumerable: true,
      get: () => {
        calls += 1
        return "leaked"
      }
    })
    expect(encodeCacheOutput(value)).toHaveProperty("reason")
    expect(calls).toBe(0)
  })

  it("refuses malformed cache envelopes", () => {
    expect(decodeCacheOutput(null)).toHaveProperty("reason")
    expect(decodeCacheOutput({ _tag: "smithers-build/cache-output/undefined-v1", extra: true }))
      .toHaveProperty("reason")
    expect(decodeCacheOutput({ _tag: "unknown", value: 1 })).toHaveProperty("reason")
  })

  it("leaves the target green and skips publication when the result cannot be stored", async () => {
    await write("package.json", `${JSON.stringify({ name: "fixture", private: true }, undefined, 2)}\n`)
    await write(
      "BUILD.ts",
      `import { Target } from "${rulesModule}"\n` +
        `import * as Node from "${nodeModule}"\n` +
        `import * as Schema from "${schemaModule}"\n` +
        `export const build = Target.make("Unstorable", {\n` +
        `  attrs: Schema.Struct({}),\n` +
        `  kinds: ["build"],\n` +
        `  success: Schema.Any,\n` +
        `  cache: true,\n` +
        `  implementation: () => Node.succeed({ value: Number.NaN })\n` +
        `})({})\n`
    )

    const lines: Array<string> = []
    const workspace = await open()
    const made = await Planner.make(workspace, "build", "//...")
    const summary = await Executor.execute({
      workspace,
      verb: "build",
      pattern: "//...",
      targets: made.targets,
      jobs: 1,
      readCache: true,
      log: (line) => lines.push(line)
    })

    expect(summary.ok).toBe(true)
    expect(summary.counts.ran).toBe(1)
    expect(lines.some((line) => line.includes("does not round trip"))).toBe(true)
    expect(await entryFiles()).toEqual([])
  })
})
