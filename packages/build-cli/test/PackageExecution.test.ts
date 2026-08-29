import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as NodeHttp from "node:http"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { makeCli, normalizeArgv } from "../src/Cli.ts"

/** Temp directories this file created; removed after the suite so a run leaves nothing in the OS temp dir. */
const temporaryDirectories: Array<string> = []
const tracked = async (directory: Promise<string>): Promise<string> => {
  const resolved = await directory
  temporaryDirectories.push(resolved)
  return resolved
}
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const write = async (root: string, relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

const workspaceModule = (extra = ""): string =>
  `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
${extra}
})
`

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" })

const commitAll = (root: string): void => {
  git(root, "init", "-q")
  git(root, "add", "-A")
  git(root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init")
}

const temporaryWorkspace = async (): Promise<string> =>
  tracked(Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-package-exec-"))))

/** Serves one command against a workspace, capturing exit code and output. */
const serve = async (
  root: string,
  args: ReadonlyArray<string>
): Promise<{ readonly exitCode: number; readonly output: string; readonly logs: string }> => {
  let exitCode = 0
  let output = ""
  let logs = ""
  const errWrite = process.stderr.write.bind(process.stderr)
  // Package execution logs status lines to stderr; capture them for asserts.
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    logs += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    return true
  }) as typeof process.stderr.write
  try {
    await makeCli({}).serve([...normalizeArgv(args), "--workspace", root], {
      exit: (code) => {
        exitCode = code
      },
      stdout: (text) => {
        output += text
      }
    })
  } finally {
    process.stderr.write = errWrite
  }
  return { exitCode, output, logs }
}

const keyOf = (planOutput: string, label: string): string => {
  const lines = planOutput.split("\n")
  for (const [index, line] of lines.entries()) {
    if (!line.includes(`"${label}"`) && !line.includes(`label: ${label}`)) continue
    for (const candidate of lines.slice(index, index + 8)) {
      const match = candidate.match(/key: ([0-9a-f]{64})/)
      if (match !== null) return match[1]!
    }
  }
  throw new Error(`no key found for ${label} in:\n${planOutput}`)
}

describe("bare-label execution and verb mapping", () => {
  it("executes a Shell.Run command target via the bare-label form", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { hello: S.Shell.Run({ command: "true" }) } })
`
    )
    commitAll(root)
    const { exitCode, logs } = await serve(root, ["//:hello"])
    expect(exitCode).toBe(0)
    expect(logs).toContain("//:hello  ran")
  })

  it("defaults a Diff target to check mode, applies with --write, and leaves check green after", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const fmt = S.Shell.Diff({ command: "printf b > out.txt", changes: ["out.txt"] })
export const Package = S.Package({ targets: { fmt } })
`
    )
    await write(root, "out.txt", "a")
    commitAll(root)
    const check = await serve(root, ["//:fmt"])
    expect(check.exitCode).toBe(1)
    expect(check.logs).toContain("drift in declared write-set")
    // Check mode never touches the real tree.
    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("a")
    const applied = await serve(root, ["//:fmt", "--write"])
    expect(applied.exitCode).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("b")
    const recheck = await serve(root, ["//:fmt"])
    expect(recheck.exitCode).toBe(0)
  })

  it("keeps check and write modes on distinct cache keys", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const fmt = S.Shell.Diff({ command: "printf b > out.txt", changes: ["out.txt"] })
export const Package = S.Package({ targets: { fmt } })
`
    )
    await write(root, "out.txt", "a")
    commitAll(root)
    const check = await serve(root, ["lint", "//:fmt", "--plan"])
    const writes = await serve(root, ["run", "//:fmt", "--plan"])
    expect(check.exitCode).toBe(0)
    expect(writes.exitCode).toBe(0)
    expect(keyOf(check.output, "//:fmt")).not.toBe(keyOf(writes.output, "//:fmt"))
  })

  it("refuses a verb the target does not participate in", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { hello: S.Shell.Run({ command: "true" }) } })
`
    )
    commitAll(root)
    const { exitCode, output } = await serve(root, ["test", "//:hello"])
    expect(exitCode).toBe(1)
    expect(output).toContain("does not support the test verb")
  })
})

describe("write-set enforcement", () => {
  it("reverts an out-of-set write, keeps the in-set change, and fails the target", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const bad = S.Shell.Diff({ command: "printf b > out.txt && printf evil > other.txt", changes: ["out.txt"] })
export const Package = S.Package({ targets: { bad } })
`
    )
    await write(root, "out.txt", "a")
    await write(root, "other.txt", "innocent")
    commitAll(root)
    const { exitCode, logs } = await serve(root, ["//:bad", "--write"])
    expect(exitCode).toBe(1)
    expect(logs).toContain("wrote outside its declared write-set")
    expect(logs).toContain("other.txt")
    expect(await Fs.readFile(NodePath.join(root, "other.txt"), "utf8")).toBe("innocent")
    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("b")
  })

  it("restores an out-of-set deletion", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const bad = S.Shell.Diff({ command: "printf b > out.txt && rm tracked.txt", changes: ["out.txt"] })
export const Package = S.Package({ targets: { bad } })
`
    )
    await write(root, "out.txt", "a")
    await write(root, "tracked.txt", "keep me")
    commitAll(root)
    const { exitCode, logs } = await serve(root, ["//:bad", "--write"])
    expect(exitCode).toBe(1)
    expect(logs).toContain("tracked.txt")
    expect(await Fs.readFile(NodePath.join(root, "tracked.txt"), "utf8")).toBe("keep me")
  })

  it("judges a write through a symlink by its resolved location", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const bad = S.Shell.Diff({ command: "printf pwn > out/esc", changes: ["out/**"] })
export const Package = S.Package({ targets: { bad } })
`
    )
    await write(root, "secret.txt", "safe")
    await Fs.mkdir(NodePath.join(root, "out"), { recursive: true })
    await Fs.symlink("../secret.txt", NodePath.join(root, "out", "esc"))
    commitAll(root)
    const { exitCode, logs } = await serve(root, ["//:bad", "--write"])
    expect(exitCode).toBe(1)
    expect(logs).toContain("wrote outside its declared write-set")
    expect(await Fs.readFile(NodePath.join(root, "secret.txt"), "utf8")).toBe("safe")
  })
})

describe("external-write confinement through escaping symlinks", () => {
  const externalDir = async (): Promise<string> =>
    tracked(Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-external-"))))

  it("reverts and fails a --write that escapes through an in-workspace symlink", async () => {
    const root = await temporaryWorkspace()
    const external = await externalDir()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const bad = S.Shell.Diff({ command: "printf b > out.txt && printf pwned > linkdir/target.txt", changes: ["out.txt"] })
export const Package = S.Package({ targets: { bad } })
`
    )
    await write(root, "out.txt", "a")
    await Fs.symlink(external, NodePath.join(root, "linkdir"))
    commitAll(root)
    const { exitCode, logs } = await serve(root, ["//:bad", "--write"])
    expect(exitCode).toBe(1)
    expect(logs).toContain("wrote outside its declared write-set")
    expect(logs).toContain("linkdir/target.txt")
    // The external write is reverted; the in-set change stays.
    const escaped = await Fs.access(NodePath.join(external, "target.txt")).then(() => true, () => false)
    expect(escaped).toBe(false)
    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("b")
  })

  it("reverts and fails a check-mode dry-run that touches the real tree through a symlink", async () => {
    const root = await temporaryWorkspace()
    const external = await externalDir()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const bad = S.Shell.Diff({ command: "printf b > out.txt && printf pwned > linkdir/leak.txt", changes: ["out.txt"] })
export const Package = S.Package({ targets: { bad } })
`
    )
    await write(root, "out.txt", "a")
    await Fs.symlink(external, NodePath.join(root, "linkdir"))
    commitAll(root)
    const { exitCode, logs } = await serve(root, ["//:bad"])
    expect(exitCode).toBe(1)
    expect(logs).toContain("check touched the real tree through a symlink")
    const escaped = await Fs.access(NodePath.join(external, "leak.txt")).then(() => true, () => false)
    expect(escaped).toBe(false)
    // Check mode never touched the real out.txt either.
    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("a")
  })
})

describe("mode-aware planning", () => {
  it("applies a --write root that is also reached as a check-mode gate", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const fmt = S.Shell.Diff({ command: "printf b > out.txt", changes: ["out.txt"] })
const aaa = S.Shell.Run({ command: "true", gates: [fmt] })
export const Package = S.Package({ targets: { aaa, fmt } })
`
    )
    await write(root, "out.txt", "a")
    commitAll(root)
    // //:aaa sorts before //:fmt, so fmt is first reached as aaa's check-mode
    // gate; the root loop then reaches it under --write. It must plan once, in
    // write mode, and apply — not reuse a stale check-mode node and report drift.
    const applied = await serve(root, ["//...", "--write"])
    expect(applied.exitCode).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("b")
    expect(applied.logs).toContain("//:fmt  ran")
  })
})

describe("write-set enforcement of gitignored paths", () => {
  it("reverts and fails an out-of-set write to a gitignored path", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const bad = S.Shell.Diff({ command: "printf b > out.txt && printf leak > ignored-leak.txt", changes: ["out.txt"] })
export const Package = S.Package({ targets: { bad } })
`
    )
    await write(root, "out.txt", "a")
    await write(root, ".gitignore", "ignored-leak.txt\n")
    commitAll(root)
    const { exitCode, logs } = await serve(root, ["//:bad", "--write"])
    expect(exitCode).toBe(1)
    expect(logs).toContain("wrote outside its declared write-set")
    expect(logs).toContain("ignored-leak.txt")
    // The gitignored out-of-set write is reverted; the in-set change stays.
    const leakGone = await Fs.access(NodePath.join(root, "ignored-leak.txt")).then(() => false, () => true)
    expect(leakGone).toBe(true)
    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("b")
  })
})

describe("artifact store", () => {
  const buildFixture = async (): Promise<string> => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const dist = S.Shell.Build({ command: "mkdir -p dist && printf art > dist/a.txt", outDirs: ["dist"] })
export const Package = S.Package({ targets: { dist } })
`
    )
    commitAll(root)
    return root
  }

  it("captures outDirs on green, answers a hit, and restores a deleted tree", async () => {
    const root = await buildFixture()
    const first = await serve(root, ["//:dist"])
    expect(first.exitCode).toBe(0)
    expect(first.logs).toContain("//:dist  ran")
    await Fs.rm(NodePath.join(root, "dist"), { recursive: true, force: true })
    const second = await serve(root, ["//:dist"])
    expect(second.exitCode).toBe(0)
    expect(second.logs).toContain("//:dist  hit")
    expect(await Fs.readFile(NodePath.join(root, "dist", "a.txt"), "utf8")).toBe("art")
  })

  it("treats a tampered blob as a miss and re-executes", async () => {
    const root = await buildFixture()
    const first = await serve(root, ["//:dist"])
    expect(first.exitCode).toBe(0)
    const cas = NodePath.join(root, ".flows", "cas")
    const blobs = await Fs.readdir(cas)
    expect(blobs.length).toBeGreaterThan(0)
    for (const blob of blobs) await Fs.writeFile(NodePath.join(cas, blob), "tampered")
    await Fs.rm(NodePath.join(root, "dist"), { recursive: true, force: true })
    const second = await serve(root, ["//:dist"])
    expect(second.exitCode).toBe(0)
    expect(second.logs).toContain("cache miss")
    expect(second.logs).toContain("//:dist  ran")
    expect(await Fs.readFile(NodePath.join(root, "dist", "a.txt"), "utf8")).toBe("art")
  })

  it("refuses a poisoned cache manifest whose outDir escapes the workspace", async () => {
    const root = await buildFixture()
    const first = await serve(root, ["//:dist"])
    expect(first.exitCode).toBe(0)
    // A sibling directory outside the workspace root, holding precious content.
    const victim = NodePath.join(NodePath.dirname(root), "victim")
    await Fs.mkdir(victim, { recursive: true })
    await Fs.writeFile(NodePath.join(victim, "precious.txt"), "precious")
    // Poison the on-disk cache entry: rewrite the manifest's outDir to point at
    // the external sibling. A hit that trusted it would rename-swap `../victim`.
    const cacheRoot = NodePath.join(root, ".flows", "cache")
    const files: Array<string> = []
    for (const shard of await Fs.readdir(cacheRoot)) {
      const shardPath = NodePath.join(cacheRoot, shard)
      if (!(await Fs.stat(shardPath)).isDirectory()) continue
      for (const name of await Fs.readdir(shardPath)) files.push(NodePath.join(shardPath, name))
    }
    let poisoned = 0
    for (const file of files) {
      const entry = JSON.parse(await Fs.readFile(file, "utf8"))
      if (entry?.output?.kind !== "build") continue
      for (const manifest of entry.output.manifests) manifest.outDir = "../victim"
      await Fs.writeFile(file, JSON.stringify(entry))
      poisoned += 1
    }
    expect(poisoned).toBeGreaterThan(0)
    await Fs.rm(NodePath.join(root, "dist"), { recursive: true, force: true })
    const second = await serve(root, ["//:dist"])
    // The poisoned entry is rejected as a miss and the build re-executes; the
    // external sibling is untouched.
    expect(second.logs).toContain("//:dist  ran")
    expect(await Fs.readFile(NodePath.join(victim, "precious.txt"), "utf8")).toBe("precious")
    expect(await Fs.readFile(NodePath.join(root, "dist", "a.txt"), "utf8")).toBe("art")
  })

  it("answers a Shell.Test repeat with a cache hit", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { check: S.Shell.Test({ command: "true" }) } })
`
    )
    commitAll(root)
    const first = await serve(root, ["//:check"])
    expect(first.exitCode).toBe(0)
    expect(first.logs).toContain("//:check  ran")
    const second = await serve(root, ["//:check"])
    expect(second.exitCode).toBe(0)
    expect(second.logs).toContain("//:check  hit")
  })

  it("fans Shell.Test shards into independently cached executions", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(root, "test.sh", `test "$1" = "--shard=$VITE_SHARD_ID/3"\n`)
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { check: S.Shell.Test({ script: S.file("//test.sh"), shards: 3 }) } })
`
    )
    commitAll(root)
    const first = await serve(root, ["//:check"])
    expect(first.exitCode).toBe(0)
    expect(first.logs).toContain("//:check  ran")
    const second = await serve(root, ["//:check"])
    expect(second.exitCode).toBe(0)
    expect(second.logs).toContain("//:check  hit")
  })

  it("refuses a command-form shard fan-out instead of running the same command N times", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { check: S.Shell.Test({ command: "true", shards: 3 }) } })
`
    )
    commitAll(root)
    const planned = await serve(root, ["//:check", "--plan"])
    expect(planned.output).toContain("Shell.Test shards cannot fan out a command-form declaration")
  })

  it("spawns a declared script under the interpreter its extension names, under either rule", async () => {
    // optimism runs one sync-superchain.sh under both S.Shell.Build and
    // S.Generate; a shell script handed to node is a parse error, not a run.
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(root, "sync.sh", "printf ok > out.txt\n")
    await write(root, "gen.mjs", "import { writeFileSync } from \"node:fs\"\nwriteFileSync(\"out.txt\", \"ok\")\n")
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const shellGenerate = S.Generate({ script: S.file("//sync.sh"), changes: ["out.txt"] })
const nodeGenerate = S.Generate({ script: S.file("//gen.mjs"), changes: ["out.txt"] })
const shellBuild = S.Shell.Build({ script: S.file("//sync.sh"), outFiles: ["//out.txt"] })
export const Package = S.Package({ targets: { nodeGenerate, shellBuild, shellGenerate } })
`
    )
    commitAll(root)
    const planned = await serve(root, ["//...", "--plan"])
    expect(planned.output).toContain("/bin/sh,sync.sh")
    expect(planned.output).toMatch(/argv\[2\]: [^\n]*node,gen\.mjs/)
    expect(planned.output).not.toMatch(/node,sync\.sh/)
  })

  it("redirects a declared Generate stdout for the command form, not only for script and bin", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { gen: S.Generate({ command: "printf ok", stdout: "out.txt" }) } })
`
    )
    commitAll(root)
    const written = await serve(root, ["//:gen", "--write"])
    expect(written.exitCode).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("ok")
  })
})

describe("NodeModule.Bin resolution through the package bin map", () => {
  /** Writes one installed fixture package plus the `.bin` entries it exposes. */
  const installFixturePackage = async (
    root: string,
    packageName: string,
    bin: string | Readonly<Record<string, string>>,
    binNames: ReadonlyArray<string>
  ): Promise<void> => {
    await write(
      root,
      NodePath.join("node_modules", ...packageName.split("/"), "package.json"),
      `${JSON.stringify({ name: packageName, version: "1.0.0", bin })}\n`
    )
    for (const name of binNames) {
      await write(root, NodePath.join("node_modules", ".bin", name), "#!/bin/sh\nexit 0\n")
      await Fs.chmod(NodePath.join(root, "node_modules", ".bin", name), 0o755)
    }
  }

  it("resolves a string-form bin to the package basename", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { stringy: S.Shell.Test({ bin: S.NodeModule.Bin("@scope/stringy") }) } })
`
    )
    // Only the basename entry exists: resolving any other name would refuse.
    await installFixturePackage(root, "@scope/stringy", "./cli.js", ["stringy"])
    commitAll(root)
    const { exitCode, logs } = await serve(root, ["//:stringy"])
    expect(exitCode).toBe(0)
    expect(logs).toContain("//:stringy  ran")
  })

  it("resolves a one-entry bin map to its key, not the package basename", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { pw: S.Shell.Test({ bin: S.NodeModule.Bin("@playwright/test") }) } })
`
    )
    // `.bin/playwright` exists; `.bin/test` (the basename) deliberately does not.
    await installFixturePackage(root, "@playwright/test", { playwright: "cli.js" }, ["playwright"])
    commitAll(root)
    const { exitCode, logs } = await serve(root, ["//:pw"])
    expect(exitCode).toBe(0)
    expect(logs).toContain("//:pw  ran")
    expect(logs).not.toContain("node_modules/.bin/test")
  })

  it("resolves a multi-entry bin map to the entry named after the package", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { deadCode: S.Shell.Test({ bin: S.NodeModule.Bin("knip") }) } })
`
    )
    // knip ships { knip, knip-bun }: one argument selects the package-name entry.
    await installFixturePackage(root, "knip", { "knip": "bin/knip.js", "knip-bun": "bin/knip-bun.js" }, [
      "knip",
      "knip-bun"
    ])
    commitAll(root)
    const { exitCode, logs } = await serve(root, ["//:deadCode"])
    expect(exitCode).toBe(0)
    expect(logs).toContain("//:deadCode  ran")
  })

  it("resolves a scoped package's multi-entry bin map to its unscoped name", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { lint: S.Shell.Test({ bin: S.NodeModule.Bin("@biomejs/biome") }) } })
`
    )
    // The unscoped basename decides: @biomejs/biome resolves the `biome` entry.
    await installFixturePackage(root, "@biomejs/biome", { "biome": "bin/biome", "biome-check": "bin/check" }, [
      "biome",
      "biome-check"
    ])
    commitAll(root)
    const { exitCode, logs } = await serve(root, ["//:lint"])
    expect(exitCode).toBe(0)
    expect(logs).toContain("//:lint  ran")
  })

  it("refuses a multi-entry bin map without an explicit name and accepts the named one", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const ambiguous = S.Shell.Test({ bin: S.NodeModule.Bin("multi") })
const explicit = S.Shell.Test({ bin: S.NodeModule.Bin("multi", "beta") })
export const Package = S.Package({ targets: { ambiguous, explicit } })
`
    )
    await installFixturePackage(root, "multi", { alpha: "a.js", beta: "b.js" }, ["alpha", "beta"])
    commitAll(root)
    const refused = await serve(root, ["//:ambiguous"])
    expect(refused.exitCode).toBe(1)
    expect(refused.logs).toContain("//:ambiguous  failed")
    expect(refused.logs).toContain(`package "multi" exposes 2 binaries (alpha, beta)`)
    expect(refused.logs).toContain("S.NodeModule.Bin(package, bin)")
    const named = await serve(root, ["//:explicit"])
    expect(named.exitCode).toBe(0)
    expect(named.logs).toContain("//:explicit  ran")
  })
})

describe("workspace-era pnpm manager", () => {
  it("loads, plans, and executes with the pnpm manifest + lockfile declaration", async () => {
    const root = await temporaryWorkspace()
    await write(
      root,
      "WORKSPACE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("pnpmfixture", {
  repository: "git+https://example.invalid/pnpmfixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Pnpm({ manifest: packageJson, lockfile: S.file("//pnpm-lock.yaml"), version: "8" }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
})
`
    )
    await write(root, "package.json", `{ "name": "pnpmfixture", "private": true }\n`)
    await write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { check: S.Shell.Test({ command: "true" }) } })
`
    )
    commitAll(root)
    const planned = await serve(root, ["//:check", "--plan"])
    expect(planned.exitCode).toBe(0)
    expect(planned.output).not.toContain("refusal")
    const { exitCode, logs } = await serve(root, ["//:check"])
    expect(exitCode).toBe(0)
    expect(logs).toContain("//:check  ran")
  })
})

describe("toolchain identity in keys", () => {
  it("re-keys a target when the resolved node_modules package version changes", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { tool: S.Shell.Test({ bin: S.NodeModule.Bin("mytool") }) } })
`
    )
    await write(root, "node_modules/mytool/package.json", `{ "name": "mytool", "version": "1.0.0" }\n`)
    await write(root, "node_modules/.bin/mytool", "#!/bin/sh\nexit 0\n")
    await Fs.chmod(NodePath.join(root, "node_modules", ".bin", "mytool"), 0o755)
    commitAll(root)
    const first = await serve(root, ["//:tool", "--plan"])
    expect(first.exitCode).toBe(0)
    await write(root, "node_modules/mytool/package.json", `{ "name": "mytool", "version": "2.0.0" }\n`)
    const second = await serve(root, ["//:tool", "--plan"])
    expect(second.exitCode).toBe(0)
    expect(keyOf(first.output, "//:tool")).not.toBe(keyOf(second.output, "//:tool"))
  })

  it("keys the four sandbox declarations apart", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const confined = S.Shell.Run({ command: "true" })
const loopback = S.Shell.Run({ command: "true", sandbox: { network: "loopback" } })
const networked = S.Shell.Run({ command: "true", sandbox: { network: true } })
const open = S.Shell.Run({ command: "true", sandbox: "none" })
export const Package = S.Package({ targets: { confined, loopback, networked, open } })
`
    )
    commitAll(root)
    const confined = await serve(root, ["//:confined", "--plan"])
    const loopback = await serve(root, ["//:loopback", "--plan"])
    const networked = await serve(root, ["//:networked", "--plan"])
    const open = await serve(root, ["//:open", "--plan"])
    const keys = [
      keyOf(confined.output, "//:confined"),
      keyOf(loopback.output, "//:loopback"),
      keyOf(networked.output, "//:networked"),
      keyOf(open.output, "//:open")
    ]
    expect(new Set(keys).size).toBe(4)
  })
})

describe("secrets", () => {
  it("fails before spawn with the missing variable named", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const push = S.Shell.Run({ command: "true", secrets: [S.Secret("SMTHRS_TEST_ABSENT_SECRET")] })
export const Package = S.Package({ targets: { push } })
`
    )
    commitAll(root)
    delete process.env["SMTHRS_TEST_ABSENT_SECRET"]
    const { exitCode, logs } = await serve(root, ["//:push"])
    expect(exitCode).toBe(1)
    expect(logs).toContain("SMTHRS_TEST_ABSENT_SECRET")
    expect(logs).toContain("missing secret")
  })
})

describe.runIf(process.platform === "darwin")("sandbox enforcement (macOS)", () => {
  it("denies network by default, allows it under { network: true }, and skips the wrapper for none", async () => {
    const server = NodeHttp.createServer((_request, response) => response.end("ok"))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    const port = typeof address === "object" && address !== null ? address.port : 0
    try {
      const root = await temporaryWorkspace()
      await write(root, "WORKSPACE.ts", workspaceModule())
      await write(
        root,
        "PACKAGE.ts",
        `import { Smithers as S } from "@smthrs/targets"
const fetchCommand = "curl -sf http://127.0.0.1:${port}/ > /dev/null"
const confined = S.Shell.Run({ command: fetchCommand })
const networked = S.Shell.Run({ command: fetchCommand, sandbox: { network: true } })
const open = S.Shell.Run({ command: fetchCommand, sandbox: "none" })
export const Package = S.Package({ targets: { confined, networked, open } })
`
      )
      commitAll(root)
      const confined = await serve(root, ["//:confined"])
      expect(confined.exitCode).toBe(1)
      const networked = await serve(root, ["//:networked"])
      expect(networked.exitCode).toBe(0)
      const open = await serve(root, ["//:open"])
      expect(open.exitCode).toBe(0)
    } finally {
      server.close()
    }
  })

  it("admits loopback listeners under { network: \"loopback\" } and nothing else", async () => {
    // A listener on 127.0.0.1 and one on ::1, each connected to once: the
    // shape of a Go httptest suite. The default profile fails the bind.
    const listen = [
      "const net = require('node:net');",
      "const once = (host) => new Promise((resolve, reject) => {",
      "  const server = net.createServer((socket) => socket.end());",
      "  server.on('error', reject);",
      "  server.listen(0, host, () => {",
      "    const client = net.connect(server.address().port, host, () => client.end());",
      "    client.on('error', reject);",
      "    client.on('close', () => server.close(() => resolve()));",
      "  });",
      "});",
      "once('127.0.0.1').then(() => once('::1')).then(() => process.exit(0), () => process.exit(1));"
    ].join(" ")
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(root, "listen.cjs", `${listen}\n`)
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const confined = S.Shell.Run({ command: ${JSON.stringify(`${process.execPath} listen.cjs`)} })
const loopback = S.Shell.Run({ command: ${
        JSON.stringify(`${process.execPath} listen.cjs`)
      }, sandbox: { network: "loopback" } })
const egress = S.Shell.Run({ command: "curl -sf --max-time 5 https://example.com/ > /dev/null", sandbox: { network: "loopback" } })
export const Package = S.Package({ targets: { confined, egress, loopback } })
`
    )
    commitAll(root)
    const confined = await serve(root, ["//:confined"])
    expect(confined.exitCode).toBe(1)
    const loopback = await serve(root, ["//:loopback"])
    expect(loopback.exitCode).toBe(0)
    const egress = await serve(root, ["//:egress"])
    expect(egress.exitCode).toBe(1)
  })
})

describe("suite aggregation", () => {
  it("runs members keep-going and reports per-member statuses on red", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const good = S.Shell.Test({ command: "true" })
const bad = S.Shell.Test({ command: "false" })
const all = S.Suite({ tests: [good, bad] })
export const Package = S.Package({ targets: { all, bad, good } })
`
    )
    commitAll(root)
    const { exitCode, logs } = await serve(root, ["//:all"])
    expect(exitCode).toBe(1)
    expect(logs).toContain("//:good  ran")
    expect(logs).toContain("//:bad  failed")
    expect(logs).toContain("suite is red")
    expect(logs).toContain("//:good=ran")
    expect(logs).toContain("//:bad=failed")
  })
})

describe("host binaries", () => {
  it("refuses a declared host binary that is absent from PATH, typed and loud", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule(`  host: S.Host({ bins: ["smthrs-definitely-absent-tool"] }),`))
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const scan = S.Shell.Test({ bin: S.Host.bin("smthrs-definitely-absent-tool") })
export const Package = S.Package({ targets: { scan } })
`
    )
    commitAll(root)
    const { exitCode, logs } = await serve(root, ["//:scan"])
    expect(exitCode).toBe(1)
    expect(logs).toContain("smthrs-definitely-absent-tool")
    expect(logs).toContain("not present on PATH")
  })

  it("fails the graph load for an undeclared host binary", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const scan = S.Shell.Test({ bin: S.Host.bin("undeclared-tool") })
export const Package = S.Package({ targets: { scan } })
`
    )
    commitAll(root)
    const { exitCode, output } = await serve(root, ["query", "//..."])
    expect(exitCode).toBe(1)
    expect(output).toContain("undeclared_host_bin")
  })
})

describe("data-edge law", () => {
  it("fails the graph load when a Run target is reachable through data", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const side = S.Shell.Run({ command: "true" })
const consumer = S.Shell.Test({ command: "true", data: [side] })
export const Package = S.Package({ targets: { consumer, side } })
`
    )
    commitAll(root)
    const { exitCode, output } = await serve(root, ["query", "//..."])
    expect(exitCode).toBe(1)
    expect(output).toContain("illegal_data_target")
  })
})

describe("generate", () => {
  it("emits a declared symlink with --write, then checks green until it is removed", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const claudeMd = S.Generate({ emit: { "CLAUDE.md": S.symlink("AGENTS.md") } })
export const Package = S.Package({ targets: { claudeMd } })
`
    )
    await write(root, "AGENTS.md", "# agents\n")
    commitAll(root)
    const missing = await serve(root, ["//:claudeMd"])
    expect(missing.exitCode).toBe(1)
    expect(missing.logs).toContain("drift in declared emit outputs")
    const applied = await serve(root, ["//:claudeMd", "--write"])
    expect(applied.exitCode).toBe(0)
    expect(await Fs.readlink(NodePath.join(root, "CLAUDE.md"))).toBe("AGENTS.md")
    const green = await serve(root, ["//:claudeMd"])
    expect(green.exitCode).toBe(0)
    await Fs.rm(NodePath.join(root, "CLAUDE.md"))
    const red = await serve(root, ["//:claudeMd"])
    expect(red.exitCode).toBe(1)
  })

  it("checks script drift against a scratch copy and applies with --write", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const gen = S.Generate({ script: S.file("//gen.mjs"), changes: ["out.gen.txt"] })
export const Package = S.Package({ targets: { gen } })
`
    )
    await write(
      root,
      "gen.mjs",
      `import { writeFileSync } from "node:fs"\nwriteFileSync("out.gen.txt", "generated\\n")\n`
    )
    await write(root, "out.gen.txt", "generated\n")
    commitAll(root)
    const green = await serve(root, ["//:gen"])
    expect(green.exitCode).toBe(0)
    await write(root, "out.gen.txt", "hand edited\n")
    const red = await serve(root, ["//:gen"])
    expect(red.exitCode).toBe(1)
    expect(red.logs).toContain("out.gen.txt")
    // Check mode never repaired the real tree.
    expect(await Fs.readFile(NodePath.join(root, "out.gen.txt"), "utf8")).toBe("hand edited\n")
    const applied = await serve(root, ["//:gen", "--write"])
    expect(applied.exitCode).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, "out.gen.txt"), "utf8")).toBe("generated\n")
  })

  it("runs the bin form through the same check, drift, and write bracket", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule(`  host: S.Host({ bins: ["sh"] }),`))
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const gen = S.Generate({
  bin: S.Host.bin("sh"),
  args: ["-c", "printf 'generated\\n' > out.gen.txt"],
  changes: ["out.gen.txt"]
})
export const Package = S.Package({ targets: { gen } })
`
    )
    await write(root, "out.gen.txt", "generated\n")
    commitAll(root)
    const green = await serve(root, ["//:gen"])
    expect(green.exitCode).toBe(0)
    expect(green.logs).not.toContain("NotImplemented")
    await write(root, "out.gen.txt", "hand edited\n")
    const red = await serve(root, ["//:gen"])
    expect(red.exitCode).toBe(1)
    expect(red.logs).toContain("out.gen.txt")
    expect(await Fs.readFile(NodePath.join(root, "out.gen.txt"), "utf8")).toBe("hand edited\n")
    const applied = await serve(root, ["//:gen", "--write"])
    expect(applied.exitCode).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, "out.gen.txt"), "utf8")).toBe("generated\n")
  })

  it("captures the stdout form inside the same check and write bracket", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule(`  host: S.Host({ bins: ["sh"] }),`))
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const gen = S.Generate({ bin: S.Host.bin("sh"), args: ["-c", "echo generated"], stdout: "out.gen.txt" })
export const Package = S.Package({ targets: { gen } })
`
    )
    await write(root, "out.gen.txt", "old\n")
    commitAll(root)
    const red = await serve(root, ["//:gen"])
    expect(red.exitCode).toBe(1)
    expect(red.logs).toContain("out.gen.txt")
    expect(await Fs.readFile(NodePath.join(root, "out.gen.txt"), "utf8")).toBe("old\n")
    expect((await serve(root, ["//:gen", "--write"])).exitCode).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, "out.gen.txt"), "utf8")).toBe("generated\n")
    expect((await serve(root, ["//:gen"])).exitCode).toBe(0)
  })
})

describe("declaration modules", () => {
  it("names the exported namespaces when a declaration reads a rule off an absent one", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const test = S.Zig.Build({ context: "." })
export const Package = S.Package({ targets: { test } })
`
    )
    commitAll(root)
    const { exitCode, output, logs } = await serve(root, ["query", "//..."])
    expect(exitCode).toBe(1)
    const text = output + logs
    expect(text).toContain("module_import_failed")
    expect(text).toContain("reading 'Build'")
    expect(text).toContain("this loader exports no such namespace")
    expect(text).toContain("Shell")
    expect(text).toContain("Github")
  })
})
