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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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

/**
 * A workspace declaring the read/write pair and one cacheable target, so a run
 * both pulls from the declared endpoint and publishes to it. The endpoint is
 * never dialled: the case stubs `fetch`, which is the transport's only exit.
 */
const cachingWorkspace = async (
  options: { readonly smuggleCredentialNames?: boolean } = {}
): Promise<string> => {
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
      `  read: Secret("READ_CACHE_TOKEN"),\n` +
      `  write: Secret("WRITE_CACHE_TOKEN")\n` +
      `})\n` +
      `export const build = ToolBuild({\n` +
      `  tool: "node",\n` +
      `  command: "node",\n` +
      `  args: ["-e", ${
        JSON.stringify(
          "require('node:fs').writeFileSync('seen.txt'," +
            "String(process.env.READ_CACHE_TOKEN ?? \"absent\") + \"|\" +" +
            "String(process.env.WRITE_CACHE_TOKEN ?? \"absent\"))"
        )
      }],\n` +
      `  inputs: [file("//src/input.txt")],\n` +
      `  outputs: ["seen.txt"],\n` +
      `  deps: [],\n` +
      `  env: ${
        options.smuggleCredentialNames === true
          ? JSON.stringify({ READ_CACHE_TOKEN: "smuggled-read", WRITE_CACHE_TOKEN: "smuggled-write" })
          : "{}"
      },\n` +
      `  cache: true,\n` +
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
  vi.restoreAllMocks()
  for (const root of roots) await Fs.rm(root, { recursive: true, force: true })
  delete process.env["ALPHA_CACHE_TOKEN"]
  delete process.env["BETA_CACHE_TOKEN"]
  delete process.env["READ_CACHE_TOKEN"]
  delete process.env["WRITE_CACHE_TOKEN"]
  delete process.env["SMITHERS_CACHE_NAMESPACE"]
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

  /**
   * The whole point of declaring a read/write pair, asserted where it counts:
   * on the wire. The declaration accepted the pair before this, and the CLI
   * projected only the read half, so both directions authenticated with the
   * credential every pull_request job holds.
   */
  it("authenticates a pull with the read credential and a publication with the write credential", async () => {
    process.env["READ_CACHE_TOKEN"] = "read-only-secret"
    process.env["WRITE_CACHE_TOKEN"] = "publish-secret"
    const seen: Array<{ readonly method: string; readonly authorization: string | null }> = []
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const method = init?.method ?? (input instanceof Request ? input.method : "GET")
      const headers = new Headers(init?.headers)
      if (String(input).includes("/ac/")) seen.push({ method, authorization: headers.get("authorization") })
      return Promise.resolve(new Response(null, { status: method === "PUT" ? 201 : 404 }))
    })
    const root = await cachingWorkspace()

    expect(await build(root)).toBe(0)

    expect(seen).toEqual([
      { method: "GET", authorization: "Bearer read-only-secret" },
      { method: "PUT", authorization: "Bearer publish-secret" }
    ])
  })

  /**
   * A tool's environment is an allowlist, so a credential never reaches it by
   * inheritance. What a target declares is applied on top of that allowlist,
   * and the declared names of the remote cache's credentials are withheld from
   * it. Only the read name was on that withholding list, so a target could
   * name the write credential in its own `env` and read it.
   */
  it("withholds both halves of a split credential from a target that declares their names", async () => {
    process.env["READ_CACHE_TOKEN"] = "read-only-secret"
    process.env["WRITE_CACHE_TOKEN"] = "publish-secret"
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
      Promise.resolve(
        new Response(null, {
          status: (init?.method ?? (input instanceof Request ? input.method : "GET")) === "PUT" ? 201 : 404
        })
      )
    )
    const root = await cachingWorkspace({ smuggleCredentialNames: true })

    expect(await build(root)).toBe(0)

    expect(await Fs.readFile(NodePath.join(root, "seen.txt"), "utf8")).toBe("absent|absent")
  })

  /**
   * Which trust domain a job runs in is host state, so it comes from the
   * environment. A namespaced job reads the trusted key and publishes
   * somewhere trunk never looks.
   */
  it("publishes into the trust domain the environment names and still reads the trusted key", async () => {
    process.env["READ_CACHE_TOKEN"] = "read-only-secret"
    process.env["WRITE_CACHE_TOKEN"] = "publish-secret"
    process.env["SMITHERS_CACHE_NAMESPACE"] = "pull-request"
    const paths: Array<{ readonly method: string; readonly path: string }> = []
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const method = init?.method ?? (input instanceof Request ? input.method : "GET")
      const path = new URL(String(input)).pathname
      if (path.startsWith("/ac/")) paths.push({ method, path })
      return Promise.resolve(new Response(null, { status: method === "PUT" ? 201 : 404 }))
    })
    const root = await cachingWorkspace()

    expect(await build(root)).toBe(0)

    expect(paths).toHaveLength(2)
    const [pull, publication] = paths
    expect(pull!.method).toBe("GET")
    expect(publication!.method).toBe("PUT")
    expect(pull!.path).not.toContain("pull-request")
    expect(publication!.path).toBe(`/ac/pull-request%2F${pull!.path.slice("/ac/".length)}`)
  })

  it("refuses an unusable trust domain rather than publishing to the trusted one", async () => {
    process.env["READ_CACHE_TOKEN"] = "read-only-secret"
    process.env["WRITE_CACHE_TOKEN"] = "publish-secret"
    process.env["SMITHERS_CACHE_NAMESPACE"] = "pull/request"
    const root = await cachingWorkspace()

    expect(await build(root)).not.toBe(0)
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
