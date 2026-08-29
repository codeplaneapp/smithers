/**
 * Where the remote-cache credential is allowed to go.
 *
 * `prepare` used to `delete process.env[tokenEnv]` after reading it. That is a
 * write to state the CLI does not own: `makeCli` is a library entry point, so
 * a programmatic caller lost a variable it had set, and two concurrent commands
 * with different declared token names deleted each other's credentials. The
 * boundary that matters is the child-process edge, and `ExecLive` holds it.
 */
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"

const rulesModule = NodePath.resolve(import.meta.dirname, "../../targets/src/Smithers.ts")

let roots: Array<string>

const write = async (root: string, relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

/**
 * A workspace that declares a remote cache under `tokenEnv` and one target
 * whose tool records what the credential looks like from inside a child.
 *
 * The target is not cacheable, so the declared endpoint is never contacted and
 * the case stays offline and fast.
 */
const workspace = async (tokenEnv: string): Promise<string> => {
  const root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-credentials-"))
  roots.push(root)
  await write(root, "package.json", `${JSON.stringify({ name: "fixture", private: true }, undefined, 2)}\n`)
  await write(root, "src/input.txt", "source\n")
  await write(
    root,
    "BUILD.ts",
    `import { file, RemoteCache, Secret, ToolBuild } from "${rulesModule}"\n` +
      `export const remoteCache = RemoteCache.make({\n` +
      `  endpoint: "https://cache.example.invalid",\n` +
      `  token: Secret(${JSON.stringify(tokenEnv)})\n` +
      `})\n` +
      `export const build = ToolBuild({\n` +
      `  tool: "node",\n` +
      `  command: "node",\n` +
      `  args: ["-e", ${
        JSON.stringify(
          "require('node:fs').writeFileSync('seen.txt'," +
            `String(process.env[${JSON.stringify(tokenEnv)}] ?? "absent") + "|" +` +
            "String(process.env.SMITHERS_CACHE_URL ?? \"absent\"))"
        )
      }],\n` +
      `  inputs: [file("//src/input.txt")],\n` +
      `  outputs: ["seen.txt"],\n` +
      `  deps: [],\n` +
      `  env: {},\n` +
      `  cache: false,\n` +
      `  cwd: "."\n` +
      `})\n`
  )
  return root
}

const build = async (root: string): Promise<number> => {
  let code = 0
  await makeCli({}).serve(["build", "//...", "--workspace", root], {
    exit: (status) => {
      code = status
    }
  })
  return code
}

beforeEach(() => {
  roots = []
})

afterEach(async () => {
  for (const root of roots) await Fs.rm(root, { recursive: true, force: true })
  delete process.env["ALPHA_CACHE_TOKEN"]
  delete process.env["BETA_CACHE_TOKEN"]
  delete process.env["SMITHERS_CACHE_URL"]
})

describe("the remote-cache credential", () => {
  it("is not deleted from the caller's environment", async () => {
    process.env["ALPHA_CACHE_TOKEN"] = "alpha-secret"
    const root = await workspace("ALPHA_CACHE_TOKEN")

    expect(await build(root)).toBe(0)

    expect(process.env["ALPHA_CACHE_TOKEN"]).toBe("alpha-secret")
  })

  it("never reaches a tool the target runs", async () => {
    process.env["ALPHA_CACHE_TOKEN"] = "alpha-secret"
    process.env["SMITHERS_CACHE_URL"] = "https://override.example.invalid"
    const root = await workspace("ALPHA_CACHE_TOKEN")

    expect(await build(root)).toBe(0)

    // Both the declared credential and the endpoint override are stripped from
    // the child environment by `ExecLive`.
    expect(await Fs.readFile(NodePath.join(root, "seen.txt"), "utf8")).toBe("absent|absent")
  })

  it("survives a concurrent command that declares a different token name", async () => {
    process.env["ALPHA_CACHE_TOKEN"] = "alpha-secret"
    process.env["BETA_CACHE_TOKEN"] = "beta-secret"
    const [alpha, beta] = await Promise.all([workspace("ALPHA_CACHE_TOKEN"), workspace("BETA_CACHE_TOKEN")])

    const codes = await Promise.all([build(alpha!), build(beta!)])

    expect(codes).toEqual([0, 0])
    // Each run reads its own declared name. Neither erases the other's.
    expect(process.env["ALPHA_CACHE_TOKEN"]).toBe("alpha-secret")
    expect(process.env["BETA_CACHE_TOKEN"]).toBe("beta-secret")
    expect(await Fs.readFile(NodePath.join(alpha!, "seen.txt"), "utf8")).toBe("absent|absent")
    expect(await Fs.readFile(NodePath.join(beta!, "seen.txt"), "utf8")).toBe("absent|absent")
  })
})
