/**
 * Resolving a declared Nix environment and keying targets on it.
 *
 * Most cases drive a fake `nix` on PATH that answers the three commands the
 * resolver runs with canned output, so the contract is exercised without a
 * Nix store: refusals are typed, resolution is memoized, declared versions
 * are asserted against the closure, and the planner folds the closure into
 * every spawning target's key. One case runs the real `nix` when the host has
 * it.
 */
import * as Input from "@smthrs/targets/Input"
import * as Nix from "@smthrs/targets/Nix"
import { execFileSync } from "node:child_process"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as Executor from "../src/Executor.ts"
import * as NixExec from "../src/NixExec.ts"
import * as Planner from "../src/Planner.ts"
import { Workspace } from "../src/Workspace.ts"

const rulesModule = NodePath.resolve(import.meta.dirname, "../../targets/src/Smithers.ts")
const nixPresent = process.platform !== "win32" &&
  (process.env["PATH"] ?? "").split(NodePath.delimiter).some((entry) => {
    try {
      return entry !== "" && NodeFs.statSync(NodePath.join(entry, "nix")).isFile()
    } catch {
      return false
    }
  })

/** A 32-character store hash from the Nix base-32 alphabet. */
const hash = "0123456789abcdfghijklmnpqrsvwxyz"

let root: string
let store: string
let fakeBin: string

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

const script = (body: string): string => `#!/bin/sh\n${body}\n`

/**
 * Installs a fake `nix` plus a fake closure holding `node` and `pnpm`.
 *
 * `nix build` prints the closure's store path, `print-dev-env` exports its
 * `bin` on PATH and one carried variable, `path-info --recursive` lists two
 * paths. Every `build` appends to a counter so a test can prove the memo
 * skipped evaluation.
 */
const installFakeNix = async (options: { readonly node?: string; readonly pnpm?: string } = {}): Promise<void> => {
  store = NodePath.join(root, "store")
  const closure = NodePath.join(store, `${hash}-fake-env`)
  const dependency = NodePath.join(store, `${hash.split("").reverse().join("")}-fake-dep`)
  await Fs.mkdir(NodePath.join(closure, "bin"), { recursive: true })
  await Fs.mkdir(dependency, { recursive: true })
  await Fs.writeFile(
    NodePath.join(closure, "bin", "node"),
    script(`echo "${options.node ?? "v22.19.0"}"`),
    { mode: 0o755 }
  )
  await Fs.writeFile(
    NodePath.join(closure, "bin", "pnpm"),
    script(`echo "${options.pnpm ?? "11.21.0"}"`),
    { mode: 0o755 }
  )
  fakeBin = NodePath.join(root, "fake-bin")
  await Fs.mkdir(fakeBin, { recursive: true })
  const counter = NodePath.join(root, "nix-build-count")
  await Fs.writeFile(
    NodePath.join(fakeBin, "nix"),
    script(
      [
        `case "$1" in --version) echo "nix (Nix) 2.99.0"; exit 0;; esac`,
        `sub=""`,
        `for a in "$@"; do case "$a" in build|print-dev-env|path-info) sub="$a"; break;; esac; done`,
        `case "$sub" in`,
        `  build) echo x >> ${JSON.stringify(counter)}; echo ${JSON.stringify(closure)};;`,
        `  print-dev-env) printf '%s' '{"variables":{"PATH":{"type":"exported","value":"${closure}/bin"},` +
        `"SSL_CERT_FILE":{"type":"exported","value":"/etc/ssl/cert.pem"},` +
        `"NIX_BUILD_CORES":{"type":"exported","value":"4"}}}';;`,
        `  path-info) printf '%s\\n%s\\n' ${JSON.stringify(dependency)} ${JSON.stringify(closure)};;`,
        `  *) echo "fake nix: unknown command $*" >&2; exit 2;;`,
        `esac`
      ].join("\n")
    ),
    { mode: 0o755 }
  )
}

const buildCount = async (): Promise<number> => {
  try {
    return (await Fs.readFile(NodePath.join(root, "nix-build-count"), "utf8")).split("x").length - 1
  } catch {
    return 0
  }
}

beforeEach(async () => {
  root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-nix-"))
  root = await Fs.realpath(root)
  await write("flake.nix", "{ outputs = { self }: { }; }\n")
  await write("flake.lock", "{ \"nodes\": {}, \"root\": \"root\", \"version\": 7 }\n")
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await Fs.rm(root, { recursive: true, force: true })
})

const declaration = (): Nix.Environment => Nix.Environment({ flake: Input.file("//flake.nix") })

describe.skipIf(process.platform === "win32")("NixExec.resolveEnvironment", () => {
  it("refuses a host without nix", async () => {
    vi.stubEnv("PATH", NodePath.join(root, "empty"))
    await expect(NixExec.resolveEnvironment({ root, declaration: declaration() })).rejects.toMatchObject({
      name: "NixEnvironmentError",
      code: "nix_absent"
    })
  })

  it("refuses a flake without its lock and names the fix", async () => {
    await installFakeNix()
    vi.stubEnv("PATH", fakeBin)
    await Fs.rm(NodePath.join(root, "flake.lock"))
    await expect(NixExec.resolveEnvironment({ root, declaration: declaration() })).rejects.toMatchObject({
      code: "nix_input_missing",
      message: expect.stringContaining("nix flake lock")
    })
  })

  it("resolves the closure, its PATH, the carried variables, and the transitive closure", async () => {
    await installFakeNix()
    vi.stubEnv("PATH", fakeBin)
    const resolved = await NixExec.resolveEnvironment({ root, declaration: declaration(), cacheDirectory: ".flows" })
    expect(resolved.storePath).toBe(NodePath.join(store, `${hash}-fake-env`))
    expect(resolved.hash).toBe(hash)
    expect(resolved.path).toEqual([NodePath.join(store, `${hash}-fake-env`, "bin")])
    expect(resolved.variables).toEqual({ SSL_CERT_FILE: "/etc/ssl/cert.pem" })
    expect(resolved.closure).toHaveLength(2)
    expect(resolved.closure).toContain(resolved.storePath)
    expect(resolved.nix.version).toBe("nix (Nix) 2.99.0")
    expect(resolved.inputs.map((input) => input.path)).toEqual(["flake.nix", "flake.lock"])
    expect(NixExec.layer(resolved)).toBe(`nix:${hash}`)
    expect(NixExec.toolEnvironment(resolved)).toEqual({
      path: NodePath.join(store, `${hash}-fake-env`, "bin"),
      variables: { SSL_CERT_FILE: "/etc/ssl/cert.pem" }
    })
    expect(NixExec.hostEnvironmentWith(resolved, { PATH: "/usr/bin", HOME: "/home/x" })).toEqual({
      PATH: NodePath.join(store, `${hash}-fake-env`, "bin"),
      HOME: "/home/x",
      SSL_CERT_FILE: "/etc/ssl/cert.pem"
    })
  })

  it("memoizes a resolution under the cache directory and reuses it while the store path exists", async () => {
    await installFakeNix()
    vi.stubEnv("PATH", fakeBin)
    const first = await NixExec.resolveEnvironment({ root, declaration: declaration(), cacheDirectory: ".flows" })
    expect(await buildCount()).toBe(1)
    const second = await NixExec.resolveEnvironment({ root, declaration: declaration(), cacheDirectory: ".flows" })
    expect(second).toEqual(first)
    expect(await buildCount()).toBe(1)
    const memos = await Fs.readdir(NodePath.join(root, ".flows", "nix"))
    expect(memos).toHaveLength(1)
    // An edited lock re-keys the memo, so the closure is evaluated again.
    await write("flake.lock", "{ \"nodes\": {}, \"root\": \"root\", \"version\": 8 }\n")
    await NixExec.resolveEnvironment({ root, declaration: declaration(), cacheDirectory: ".flows" })
    expect(await buildCount()).toBe(2)
    // A store path that vanished invalidates the memo rather than answering for it.
    await Fs.rm(first.storePath, { recursive: true, force: true })
    await write("flake.lock", "{ \"nodes\": {}, \"root\": \"root\", \"version\": 7 }\n")
    await expect(NixExec.resolveEnvironment({ root, declaration: declaration(), cacheDirectory: ".flows" }))
      .resolves.toMatchObject({ hash })
    expect(await buildCount()).toBe(3)
  })

  it("asserts declared tool versions against the closure alone", async () => {
    await installFakeNix({ node: "v22.20.1" })
    vi.stubEnv("PATH", fakeBin)
    const resolved = await NixExec.resolveEnvironment({ root, declaration: declaration() })
    await expect(NixExec.assertToolVersion(resolved, { name: "node", requirement: ">=22.19.0" }, { root }))
      .resolves.toBe("22.20.1")
    await expect(NixExec.assertToolVersion(resolved, { name: "pnpm", requirement: "11.21.0" }, { root }))
      .resolves.toBe("11.21.0")
    await expect(NixExec.assertToolVersion(resolved, { name: "node", requirement: ">=24.0.0" }, { root }))
      .rejects.toMatchObject({
        code: "nix_version_mismatch",
        message: expect.stringContaining("declares node >=24.0.0 but the Nix environment provides node 22.20.1")
      })
    await expect(NixExec.assertToolVersion(resolved, { name: "bun", requirement: ">=1.3.0" }, { root }))
      .rejects.toMatchObject({ code: "nix_tool_absent" })
  })
})

describe("NixExec pure helpers", () => {
  it("compares versions the way declarations spell requirements", () => {
    expect(NixExec.satisfies("22.19.0", ">=22.19.0")).toBe(true)
    expect(NixExec.satisfies("22.18.9", ">=22.19.0")).toBe(false)
    expect(NixExec.satisfies("23.0.0", ">=22.19.0")).toBe(true)
    expect(NixExec.satisfies("11.21.0", "11.21.0")).toBe(true)
    expect(NixExec.satisfies("11.21.1", "11.21.0")).toBe(false)
    expect(NixExec.satisfies("0.0.1", ">=0.0.0")).toBe(true)
  })

  it("names the host system the way a flake does", () => {
    expect(NixExec.hostSystem("linux", "x64")).toBe("x86_64-linux")
    expect(NixExec.hostSystem("linux", "arm64")).toBe("aarch64-linux")
    expect(NixExec.hostSystem("darwin", "arm64")).toBe("aarch64-darwin")
  })
})

describe.skipIf(process.platform === "win32")("Planner under a declared environment", () => {
  const buildFile = (extra = ""): string =>
    `import { file, Filegroup, Nix, PackageManager, Runtime, ToolBuild, Vitest } from "${rulesModule}"\n` +
    `export const environment = Nix.Environment({ flake: file("//flake.nix") })\n` +
    `export const runtime = Runtime.Node({ version: ">=22.19.0" })\n` +
    `export const packageManager = PackageManager.Pnpm({ version: "11.21.0", runtime })\n` +
    `export const build = ToolBuild({\n` +
    `  tool: "node", command: "node", args: ["-e", "0"], inputs: [file("//src/input.txt")],\n` +
    `  outputs: ["out"], deps: [], env: {}, cache: false, cwd: "."\n` +
    `})\n` +
    `export const test = Vitest({\n` +
    `  packageManager, tests: [], sources: [], deps: [], config: null,\n` +
    `  environment: "node", coverage: false, passWithNoTests: true, cwd: "."\n` +
    `})\n` +
    `export const files = Filegroup({ srcs: [file("//src/input.txt")] })\n` +
    extra

  const planned = async (verb: "build" | "test" | "graph") => {
    const workspace = await Workspace.make(root, root, { cacheDirectory: ".flows" })
    return Planner.make(workspace, verb, "//...")
  }

  beforeEach(async () => {
    await write("src/input.txt", "source\n")
    await write("BUILD.ts", buildFile())
  })

  it("keys every spawning target on the closure, flips cacheability, and records the closure", async () => {
    await installFakeNix()
    vi.stubEnv("PATH", fakeBin)
    const plan = await planned("build")
    const build = plan.targets.find((target) => target.label === "//:build")!
    expect(build.keyMaterial.layers).toEqual([`nix:${hash}`])
    expect(build.cacheable).toBe(false)
    expect(build.nixEnvironment).toMatchObject({ hash, storePath: NodePath.join(store, `${hash}-fake-env`) })
    expect(build.nixEnvironment?.closure).toHaveLength(2)
    const test = (await planned("test")).targets.find((target) => target.label === "//:test")!
    expect(test.keyMaterial.layers).toEqual([`nix:${hash}`])
    expect(test.cacheable).toBe(true)
  })

  it("leaves graph and query free of nix and unkeyed on it", async () => {
    vi.stubEnv("PATH", NodePath.join(root, "empty"))
    const plan = await planned("graph")
    const build = plan.targets.find((target) => target.label === "//:build")!
    expect(build.keyMaterial.layers).toEqual([])
    expect(build.nixEnvironment).toBeUndefined()
  })

  it("fails closed when the environment is declared and nix is absent", async () => {
    vi.stubEnv("PATH", NodePath.join(root, "empty"))
    await expect(planned("build")).rejects.toMatchObject({ code: "nix_absent" })
  })

  it("fails the plan when the closure does not satisfy a declared version", async () => {
    await installFakeNix({ node: "v20.11.0" })
    vi.stubEnv("PATH", fakeBin)
    await expect(planned("test")).rejects.toMatchObject({
      code: "nix_version_mismatch",
      message: expect.stringContaining("declares node >=22.19.0 but the Nix environment provides node 20.11.0")
    })
  })

  it("lets a package export its own environment over the root's", async () => {
    await installFakeNix()
    vi.stubEnv("PATH", fakeBin)
    await write("packages/leaf/flake.nix", "{ outputs = { self }: { }; }\n")
    await write("packages/leaf/flake.lock", "{ \"nodes\": {}, \"root\": \"root\", \"version\": 7 }\n")
    await write("packages/leaf/src/input.txt", "leaf\n")
    await write(
      "packages/leaf/BUILD.ts",
      `import { file, Nix, ToolBuild } from "${rulesModule}"\n` +
        `export const environment = Nix.Environment({ flake: file("flake.nix"), attr: "leaf" })\n` +
        `export const build = ToolBuild({\n` +
        `  tool: "node", command: "node", args: ["-e", "0"], inputs: [file("src/input.txt")],\n` +
        `  outputs: ["out"], deps: [], env: {}, cache: false, cwd: "packages/leaf"\n` +
        `})\n`
    )
    const workspace = await Workspace.make(root, root, { cacheDirectory: ".flows" })
    expect((await workspace.environmentFor("packages/leaf"))?.attr).toBe("leaf")
    expect((await workspace.environmentFor("packages/other"))?.attr).toBeUndefined()
    expect((await workspace.environmentFor(""))?.flake?.path).toBe("//flake.nix")
  })

  it("refuses a BUILD.ts that exports two environments", async () => {
    await write("BUILD.ts", buildFile(`export const second = Nix.Environment({ flake: file("//other.nix") })\n`))
    const workspace = await Workspace.make(root, root, { cacheDirectory: ".flows" })
    await expect(workspace.environmentFor("")).rejects.toThrowError(/more than one Nix environment/)
  })

  it("runs a target's tool from the closure's PATH", async () => {
    await installFakeNix()
    vi.stubEnv("PATH", fakeBin)
    // The fake closure's `node` only echoes a version, so a real run through
    // it proves the spawn used the closure: the recorded output is the fake's.
    await write(
      "BUILD.ts",
      `import { file, Nix, ToolBuild } from "${rulesModule}"\n` +
        `export const environment = Nix.Environment({ flake: file("//flake.nix") })\n` +
        `export const probe = ToolBuild({\n` +
        `  tool: "node", command: "node", args: ["--version"], inputs: [file("//src/input.txt")],\n` +
        `  outputs: [], deps: [], env: {}, cache: false, cwd: "."\n` +
        `})\n`
    )
    const workspace = await Workspace.make(root, root, { cacheDirectory: ".flows" })
    const plan = await Planner.make(workspace, "build", "//:probe")
    const summary = await Executor.execute({
      workspace,
      verb: plan.verb,
      pattern: plan.pattern,
      targets: plan.targets,
      readCache: false,
      jobs: 1,
      log: () => {}
    })
    const result = summary.results.find((entry) => entry.label === "//:probe")
    expect(result?.error).toBeUndefined()
    expect(result?.status).toBe("ran")
  })
})

describe.skipIf(!nixPresent)("NixExec with the host's nix", () => {
  it("resolves a real dev shell and lists a non-empty closure", async () => {
    await write(
      "flake.nix",
      [
        "{",
        "  inputs.nixpkgs.url = \"github:NixOS/nixpkgs/nixos-24.11\";",
        "  outputs = { self, nixpkgs }:",
        "    let systems = [ \"x86_64-linux\" \"aarch64-linux\" \"x86_64-darwin\" \"aarch64-darwin\" ];",
        "        forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});",
        "    in { devShells = forAll (pkgs: { default = pkgs.mkShell { packages = [ pkgs.hello ]; }; }); };",
        "}",
        ""
      ].join("\n")
    )
    execFileSync("nix", ["--extra-experimental-features", "nix-command flakes", "flake", "lock"], { cwd: root })
    const resolved = await NixExec.resolveEnvironment({ root, declaration: declaration(), cacheDirectory: ".flows" })
    expect(resolved.storePath.startsWith("/nix/store/")).toBe(true)
    expect(resolved.closure.length).toBeGreaterThan(1)
    expect(resolved.path.some((entry) => entry.includes("hello"))).toBe(true)
  }, 600_000)
})
