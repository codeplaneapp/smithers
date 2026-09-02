/**
 * The BUILD.ts surface under confinement.
 *
 * A root `Workspace({ sandbox })` declaration puts every tool-running target
 * under the host's mechanism through `ExecLive`; the read set is the target's
 * expanded declared inputs plus its dependencies' outputs, the write set its
 * declared outputs. Without the declaration the surface runs unconfined, and
 * an unconfined result never reaches the shared cache tier.
 */
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Executor from "../src/Executor.ts"
import * as Planner from "../src/Planner.ts"
import { resolveConfig, Workspace } from "../src/Workspace.ts"

const rulesModule = NodePath.resolve(import.meta.dirname, "../../targets/src/Smithers.ts")
const configModule = NodePath.resolve(import.meta.dirname, "../../targets/src/Config.ts")

let root: string

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

const buildFile = (sandbox: string | undefined): string =>
  `import { Workspace } from "${configModule}"\n` +
  `import { file, ToolBuild } from "${rulesModule}"\n` +
  (sandbox === undefined
    ? ""
    : `export const config = Workspace({ cacheDirectory: ".flows", sandbox: ${sandbox} })\n`) +
  `const tool = (script) => ToolBuild({ tool: "sh", command: "/bin/sh", args: ["-c", script], inputs: [file("in.txt")], outputs: ["out"], deps: [], env: {}, cache: false })\n` +
  `export const declared = tool("mkdir -p out && cat in.txt > out/result.txt")\n` +
  `export const undeclaredRead = tool("mkdir -p out && cat secret.txt > out/result.txt")\n` +
  `export const undeclaredWrite = tool("mkdir -p out && cat in.txt > out/result.txt && printf leak > leak.txt")\n`

const run = async (label: string): Promise<Executor.Summary> => {
  const config = await resolveConfig(root)
  const workspace = await Workspace.make(root, root, {
    cacheDirectory: config.cacheDirectory,
    sandbox: config.sandbox,
    sandboxes: config.sandboxes
  })
  const plan = await Planner.make(workspace, "build", label)
  return Executor.execute({
    workspace,
    verb: "build",
    pattern: label,
    targets: plan.targets,
    jobs: 1,
    readCache: false,
    log: () => {}
  })
}

const outcome = (
  summary: Executor.Summary,
  label: string
): { readonly status: string | undefined; readonly error: string | undefined } => {
  const entry = summary.results.find((row) => row.label === label)
  return { status: entry?.status, error: entry?.error }
}

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-sandbox-build-")))
  await write("package.json", `${JSON.stringify({ name: "fixture", private: true }, undefined, 2)}\n`)
  await write("in.txt", "declared\n")
  await write("secret.txt", "s3cret\n")
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe.runIf(process.platform === "darwin" || process.platform === "linux")("BUILD.ts confinement", () => {
  it("confines every target when the root declaration asks for it", async () => {
    await write("BUILD.ts", buildFile("{}"))
    const declared = await run("//:declared")
    expect(outcome(declared, "//:declared").status).toBe("ran")
    expect(await Fs.readFile(NodePath.join(root, "out", "result.txt"), "utf8")).toBe("declared\n")

    const read = await run("//:undeclaredRead")
    expect(outcome(read, "//:undeclaredRead").status).toBe("failed")
    expect(outcome(read, "//:undeclaredRead").error).toMatch(/secret\.txt/)

    const wrote = await run("//:undeclaredWrite")
    expect(outcome(wrote, "//:undeclaredWrite").status).toBe("failed")
    expect(outcome(wrote, "//:undeclaredWrite").error).toMatch(/leak\.txt/)
    await expect(Fs.access(NodePath.join(root, "leak.txt"))).rejects.toThrow()
  })

  it("runs unconfined without the declaration and under an explicit none", async () => {
    await write("BUILD.ts", buildFile(undefined))
    expect(outcome(await run("//:undeclaredRead"), "//:undeclaredRead").status).toBe("ran")
    await write("BUILD.ts", buildFile("\"none\""))
    expect(outcome(await run("//:undeclaredWrite"), "//:undeclaredWrite").status).toBe("ran")
    expect(await Fs.readFile(NodePath.join(root, "leak.txt"), "utf8")).toBe("leak")
  })

  it("resolves the declared policy and mechanism into the workspace", async () => {
    await write("BUILD.ts", buildFile("{ network: \"loopback\" }"))
    const config = await resolveConfig(root)
    expect(config.sandbox).toEqual({ network: "loopback" })
    expect(config.sandboxes).toBeUndefined()
  })
})
