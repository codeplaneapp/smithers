import * as Effect from "effect/Effect"
import { spawnSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as KnownFile from "../src/KnownFile.ts"

let root: string

beforeEach(async () => {
  root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-known-files-"))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("known-file discovery", () => {
  it("emits workspace-absolute and package-local spellings, never a `..` spelling", () => {
    const discovery = KnownFile.knownFileDiscovery([
      "PACKAGE.ts",
      "root.txt",
      "pkg/PACKAGE.ts",
      "pkg/local.txt"
    ])
    expect(discovery.packageDirectories).toEqual(["", "pkg"])
    expect(discovery.literals).toEqual(expect.arrayContaining([
      "//root.txt",
      "root.txt",
      "//pkg/local.txt",
      "pkg/local.txt",
      "local.txt"
    ]))
    expect(discovery.literals).not.toContain("../root.txt")
    expect(discovery.literals.some((literal) => literal.includes(".."))).toBe(false)
  })

  it("uses the input walk's nested ignores and host-state exclusions", async () => {
    await Fs.mkdir(NodePath.join(root, "pkg", "node_modules"), { recursive: true })
    await Fs.mkdir(NodePath.join(root, ".flows"), { recursive: true })
    await Fs.writeFile(NodePath.join(root, "PACKAGE.ts"), "")
    await Fs.writeFile(NodePath.join(root, "pkg", "PACKAGE.ts"), "")
    await Fs.writeFile(NodePath.join(root, "pkg", ".gitignore"), "ignored.txt\n")
    await Fs.writeFile(NodePath.join(root, "pkg", "kept.txt"), "kept")
    await Fs.writeFile(NodePath.join(root, "pkg", "ignored.txt"), "ignored")
    await Fs.writeFile(NodePath.join(root, "pkg", "node_modules", "dependency.txt"), "dependency")
    await Fs.writeFile(NodePath.join(root, ".flows", "state.txt"), "state")

    const discovery = await KnownFile.discoverKnownFiles(root)
    expect(discovery.files).toContain("pkg/kept.txt")
    expect(discovery.files).not.toContain("pkg/ignored.txt")
    expect(discovery.files).not.toContain("pkg/node_modules/dependency.txt")
    expect(discovery.files).not.toContain(".flows/state.txt")
  })

  it("stops at an initialized nested repository instead of listing its files", async () => {
    await Fs.writeFile(NodePath.join(root, "PACKAGE.ts"), "")
    await Fs.mkdir(NodePath.join(root, "vendor", "submodule", "src"), { recursive: true })
    // An initialized submodule carries `.git` as a gitfile, a vendored clone
    // carries it as a directory; both are repositories of their own.
    await Fs.writeFile(
      NodePath.join(root, "vendor", "submodule", ".git"),
      "gitdir: ../../.git/modules/vendor/submodule\n"
    )
    await Fs.writeFile(NodePath.join(root, "vendor", "submodule", "src", "lib.rs"), "")
    await Fs.mkdir(NodePath.join(root, "vendor", "clone", ".git"), { recursive: true })
    await Fs.writeFile(NodePath.join(root, "vendor", "clone", ".git", "HEAD"), "ref: refs/heads/main\n")
    await Fs.writeFile(NodePath.join(root, "vendor", "clone", "README.md"), "")
    await Fs.mkdir(NodePath.join(root, "vendor", "owned"), { recursive: true })
    await Fs.writeFile(NodePath.join(root, "vendor", "owned", "kept.txt"), "kept")

    const discovery = await KnownFile.discoverKnownFiles(root)
    expect(discovery.files).toContain("vendor/owned/kept.txt")
    expect(discovery.files.filter((path) => path.startsWith("vendor/submodule/"))).toEqual([])
    expect(discovery.files.filter((path) => path.startsWith("vendor/clone/"))).toEqual([])
  })

  it("stops at every path .gitmodules declares, initialized or not", async () => {
    await Fs.writeFile(NodePath.join(root, "PACKAGE.ts"), "")
    await Fs.writeFile(
      NodePath.join(root, ".gitmodules"),
      `[submodule "vendor/jj"]\n\tpath = vendor/jj\n\turl = https://example.invalid/jj.git\n`
    )
    await Fs.mkdir(NodePath.join(root, "vendor", "jj", "lib"), { recursive: true })
    await Fs.writeFile(NodePath.join(root, "vendor", "jj", "Cargo.toml"), "")
    await Fs.writeFile(NodePath.join(root, "vendor", "jj", "lib", "lib.rs"), "")

    const discovery = await KnownFile.discoverKnownFiles(root)
    expect(discovery.files).toContain(".gitmodules")
    expect(discovery.files.filter((path) => path.startsWith("vendor/jj/"))).toEqual([])
  })
})

describe("known-file generated declarations", () => {
  it("writes atomically and reports drift through GeneratedFile", async () => {
    await Fs.writeFile(NodePath.join(root, "PACKAGE.ts"), "")
    await Fs.writeFile(NodePath.join(root, "good.txt"), "good")
    await Effect.runPromise(KnownFile.writeKnownFileDeclaration(root))
    await expect(Effect.runPromise(KnownFile.checkKnownFileDeclaration(root))).resolves.toBeUndefined()

    const output = NodePath.join(root, KnownFile.defaultOutput)
    const generated = await Fs.readFile(output, "utf8")
    expect(generated).toContain("| \"//good.txt\"")
    await Fs.appendFile(output, "// drift\n")
    await expect(Effect.runPromise(KnownFile.checkKnownFileDeclaration(root))).rejects.toMatchObject({
      _tag: "smithers-build/DriftError"
    })
  })
})

describe("Smithers.file compile-time opt-in", () => {
  const packageRoot = NodePath.resolve(import.meta.dirname, "..")
  const compiler = NodePath.join(packageRoot, "node_modules", "typescript", "bin", "tsc")

  const compile = async (path: string, generated: boolean): Promise<ReturnType<typeof spawnSync>> => {
    const source = NodePath.join(root, "fixture.ts")
    const registry = NodePath.join(root, "known-files.d.ts")
    const config = NodePath.join(root, "tsconfig.json")
    await Fs.writeFile(
      source,
      `import { Smithers } from "@smthrs/targets"\nSmithers.file(${JSON.stringify(path)})\n`
    )
    if (generated) {
      await Fs.writeFile(
        registry,
        KnownFile.renderKnownFileDeclaration(KnownFile.knownFileDiscovery(["PACKAGE.ts", "good.txt"]))
      )
    }
    await Fs.writeFile(
      config,
      JSON.stringify({
        compilerOptions: {
          allowImportingTsExtensions: true,
          baseUrl: packageRoot,
          ignoreDeprecations: "6.0",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          paths: {
            "@smthrs/targets": ["src/index.ts"],
            "@smthrs/targets/*": ["src/*.ts"]
          },
          skipLibCheck: true,
          strict: true,
          target: "ES2024",
          typeRoots: [NodePath.join(packageRoot, "node_modules", "@types")],
          types: ["node"]
        },
        files: generated ? [source, registry] : [source]
      })
    )
    return spawnSync(process.execPath, [compiler, "-p", config, "--pretty", "false"], {
      cwd: packageRoot,
      encoding: "utf8"
    })
  }

  // Two `tsc` compilations, which are CPU bound. Measured at 4.9 s on an idle
  // developer machine and timed out against the 30 s package default on a
  // two-core hosted runner, so the runner is more than six times slower. The
  // budget accommodates that with room to spare and still bounds a genuine
  // hang, which would not finish at any budget.
  it("accepts a generated good path and rejects a generated bad path", { timeout: 120_000 }, async () => {
    const good = await compile("//good.txt", true)
    expect(good.status, String(good.stdout) + String(good.stderr)).toBe(0)

    const bad = await compile("//missing.txt", true)
    expect(bad.status).toBe(2)
    expect(bad.stdout).toContain(
      `Argument of type '"//missing.txt"' is not assignable to parameter of type`
    )
  })

  it("keeps ungenerated workspaces on the string fallback", async () => {
    const fallback = await compile("//missing.txt", false)
    expect(fallback.status, String(fallback.stdout) + String(fallback.stderr)).toBe(0)
  })
})
