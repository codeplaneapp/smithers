import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as Planner from "../src/Planner.ts"
import {
  discoverable,
  ensureGitignored,
  isGitPath,
  maximumGitignoreBytes,
  resolveConfig,
  resolveRemoteCache,
  Workspace
} from "../src/Workspace.ts"

/**
 * The failure `execFile` reports when git is not installed at all. That is one
 * of the two cases the filesystem fallback answers completely, so it is what
 * the tests that exercise fallback discovery simulate.
 */
const gitMissing = (): Error => Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" })

/**
 * The failure git reports for a directory that is not a worktree: a non-zero
 * exit status, which `execFile` reports as a numeric `code`, and a diagnostic
 * on stderr.
 */
const notARepository = (): Error => Object.assign(new Error("Command failed: git"), { code: 128 })

const gitResult = vi.hoisted((): { error: Error | null; stdout: string; stderr: string } => ({
  error: null,
  stdout: "",
  stderr: ""
}))

vi.mock("node:child_process", () => ({
  execFile: (
    _file: unknown,
    _args: unknown,
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ): void => callback(gitResult.error, gitResult.stdout, gitResult.stderr)
}))

let root: string

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

const read = (relative: string): Promise<string> => Fs.readFile(NodePath.join(root, relative), "utf8")

/**
 * A root BUILD.ts file declaring a workspace configuration. Each test gets its
 * own temporary directory, so the loader never returns a cached namespace from
 * an earlier case.
 */
const buildFile = (options: string): string =>
  `import { Workspace } from "${NodePath.resolve(import.meta.dirname, "../../targets/src/Config.ts")}"\n` +
  `export const workspace = Workspace(${options})\n`

const remoteCacheBuildFile = (options: string): string =>
  `import { RemoteCache, Secret } from "${NodePath.resolve(import.meta.dirname, "../../targets/src/Smithers.ts")}"\n` +
  `export const remoteCache = RemoteCache.make(${options})\n`

/**
 * The declared toolchain every tool-running fixture target takes, prepended to
 * any fixture BUILD.ts whose targets run a manager or evaluate a program.
 */
const toolchain = `const runtime = Runtime.Node({ version: ">=22.19.0" })\n` +
  `const packageManager = PackageManager.Pnpm({ version: "11.21.0", runtime })\n`

beforeEach(async () => {
  gitResult.error = gitMissing()
  gitResult.stdout = ""
  gitResult.stderr = ""
  root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-workspace-"))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("resolveConfig", () => {
  it("defaults to .flows when no BUILD.ts file exists", async () => {
    expect(await resolveConfig(root)).toEqual({ cacheDirectory: ".flows", gitignored: false })
  })

  it("defaults to .flows when the root BUILD.ts declares no configuration", async () => {
    await write("BUILD.ts", "export const nothing = 1\n")
    expect(await resolveConfig(root)).toEqual({ cacheDirectory: ".flows", gitignored: false })
  })

  it("reads the root BUILD.ts declaration", async () => {
    await write("BUILD.ts", buildFile(`{ cacheDirectory: "build/cache", gitignored: true }`))
    expect(await resolveConfig(root)).toEqual({ cacheDirectory: "build/cache", gitignored: true })
  })

  it("evaluates BUILD.ts as ESM even when the workspace package type is CommonJS", async () => {
    await write("package.json", `${JSON.stringify({ type: "commonjs" })}\n`)
    await write(
      "BUILD.ts",
      `import { Workspace } from "${NodePath.resolve(import.meta.dirname, "../../targets/src/Config.ts")}"\n` +
        "const cacheDirectory = await Promise.resolve(\"build/cache\")\n" +
        "export const workspace = Workspace({ cacheDirectory, gitignored: false })\n"
    )
    expect(await resolveConfig(root)).toEqual({ cacheDirectory: "build/cache", gitignored: false })
  })

  it("prefers the flag over the declaration", async () => {
    await write("BUILD.ts", buildFile(`{ cacheDirectory: "build/cache", gitignored: true }`))
    expect(await resolveConfig(root, "flag/dir")).toEqual({
      cacheDirectory: "flag/dir",
      gitignored: true
    })
  })

  it("prefers the flag over the .flows default", async () => {
    expect(await resolveConfig(root, "flag/dir/")).toEqual({
      cacheDirectory: "flag/dir",
      gitignored: false
    })
  })

  it("refuses an invalid flag", async () => {
    await expect(resolveConfig(root, "")).rejects.toThrow(/must not be empty/)
    await expect(resolveConfig(root, "/tmp/elsewhere")).rejects.toThrow(/workspace-relative/)
    await expect(resolveConfig(root, "../escape")).rejects.toThrow(/must not leave the workspace/)
  })

  it("refuses an invalid declaration while the BUILD.ts file evaluates", async () => {
    await write("BUILD.ts", buildFile(`{ cacheDirectory: "../escape" }`))
    await expect(resolveConfig(root)).rejects.toThrow(/must not leave the workspace/)
  })

  it("validates a structurally forged declaration", async () => {
    await write(
      "BUILD.ts",
      `import * as Config from "${NodePath.resolve(import.meta.dirname, "../../targets/src/Config.ts")}"\n` +
        "export const config = {\n" +
        "  [Config.TypeId]: Config.TypeId,\n" +
        "  cacheDirectory: \"../escape\",\n" +
        "  gitignored: false\n" +
        "}\n"
    )
    await expect(resolveConfig(root)).rejects.toThrow(/must not leave the workspace/)
  })
})

describe("resolveRemoteCache", () => {
  it("returns none without an environment override or declaration", async () => {
    expect(await resolveRemoteCache(root)).toBeUndefined()
  })

  it("reads the inert root BUILD.ts declaration", async () => {
    await write(
      "BUILD.ts",
      remoteCacheBuildFile(`{
      endpoint: "https://declared.example.test/",
      token: Secret("DECLARED_CACHE_TOKEN")
    }`)
    )
    expect(await resolveRemoteCache(root)).toEqual({
      endpoint: "https://declared.example.test",
      tokenEnv: "DECLARED_CACHE_TOKEN"
    })
  })

  it("never returns the bearer token value with the declaration", async () => {
    process.env["PROJECT_CACHE_TOKEN"] = "top-secret"
    try {
      await write(
        "BUILD.ts",
        remoteCacheBuildFile(`{
      endpoint: "https://declared.example.test",
      token: Secret("PROJECT_CACHE_TOKEN")
    }`)
      )
      const resolved = await resolveRemoteCache(root)
      expect(resolved).toEqual({
        endpoint: "https://declared.example.test",
        tokenEnv: "PROJECT_CACHE_TOKEN"
      })
      expect(JSON.stringify(resolved)).not.toContain("top-secret")
    } finally {
      delete process.env["PROJECT_CACHE_TOKEN"]
    }
  })

  /**
   * Root declaration modules were once imported with the whole of
   * `process.env` deleted and restored around the import. That hid nothing
   * from a BUILD.ts file, which is executable TypeScript that can read
   * `/proc/self/environ` or spawn a child, and it corrupted state the CLI does
   * not own. This is the property the honest design owes a caller: evaluating
   * a workspace never disturbs the environment, not even one that another
   * fiber is writing to at the same moment.
   */
  it("leaves the caller's environment untouched, including concurrent writes", async () => {
    process.env["PRESERVED_BY_CALLER"] = "kept"
    try {
      await write(
        "BUILD.ts",
        remoteCacheBuildFile(`{
      endpoint: "https://declared.example.test",
      token: Secret("DECLARED_CACHE_TOKEN")
    }`)
      )
      const resolution = resolveRemoteCache(root)
      // A concurrent caller sets a variable while the workspace evaluates.
      process.env["SET_DURING_EVALUATION"] = "concurrent"
      await resolution

      expect(process.env["PRESERVED_BY_CALLER"]).toBe("kept")
      expect(process.env["SET_DURING_EVALUATION"]).toBe("concurrent")
    } finally {
      delete process.env["PRESERVED_BY_CALLER"]
      delete process.env["SET_DURING_EVALUATION"]
    }
  })

  it("prefers SMITHERS_CACHE_URL while retaining the declared tokenEnv", async () => {
    await write(
      "BUILD.ts",
      remoteCacheBuildFile(`{
      endpoint: "https://declared.example.test",
      token: Secret("DECLARED_CACHE_TOKEN")
    }`)
    )
    expect(await resolveRemoteCache(root, "https://override.example.test/")).toEqual({
      endpoint: "https://override.example.test",
      tokenEnv: "DECLARED_CACHE_TOKEN"
    })
  })

  it("uses the default tokenEnv for an environment-only endpoint", async () => {
    expect(await resolveRemoteCache(root, "https://override.example.test")).toEqual({
      endpoint: "https://override.example.test",
      tokenEnv: "SMITHERS_CACHE_TOKEN"
    })
  })

  it("validates a structurally forged declaration", async () => {
    await write(
      "BUILD.ts",
      `import { RemoteCache } from "${NodePath.resolve(import.meta.dirname, "../../targets/src/Smithers.ts")}"\n` +
        "export const remoteCache = {\n" +
        "  [RemoteCache.TypeId]: RemoteCache.TypeId,\n" +
        "  endpoint: \"http://insecure.example.test\",\n" +
        "  token: { _tag: \"Secret\", env: \"SMITHERS_CACHE_TOKEN\" }\n" +
        "}\n"
    )
    await expect(resolveRemoteCache(root)).rejects.toThrow(/use HTTPS/)
  })

  /**
   * The remote cache is host state: neither its endpoint, nor the name of the
   * variable holding its bearer token, nor the token value reaches a target
   * key. What a BUILD.ts file deliberately copies into its own attrs is a
   * different question, and the answer there is the same as Bazel's: a
   * declaration that writes a value into an attr has made it key material.
   */
  it("keeps remote host state out of target key material", async () => {
    process.env["PROJECT_CACHE_TOKEN"] = "top-secret"
    try {
      await write(
        "BUILD.ts",
        `import { DepsLint, file, glob, PackageManager, RemoteCache, Runtime, Secret } from "${
          NodePath.resolve(import.meta.dirname, "../../targets/src/Smithers.ts")
        }"\n` +
          toolchain +
          "export const remoteCache = RemoteCache.make({\n" +
          "  endpoint: \"https://cache.example.test\",\n" +
          "  token: Secret(\"PROJECT_CACHE_TOKEN\")\n" +
          "})\n" +
          "export const lint = DepsLint({\n" +
          "  runtime,\n" +
          "  packageManager,\n" +
          "  packageJson: file(\"package.json\"),\n" +
          "  sources: [glob(\"src/**/*.ts\")],\n" +
          "  deps: [],\n" +
          "  tool: \"knip\",\n" +
          "  ignoreDependencies: [\"unused\"],\n" +
          "  ignoreBinaries: [],\n" +
          "  cwd: \".\"\n" +
          "})\n"
      )
      await write("package.json", "{}\n")
      await write("src/index.ts", "export const value = 1\n")
      const plan = await Planner.make(await Workspace.make(root, root), "lint", "//:lint")
      const keyMaterial = JSON.stringify(plan.targets[0]?.keyMaterial)
      expect(keyMaterial).not.toContain("cache.example.test")
      expect(keyMaterial).not.toContain("PROJECT_CACHE_TOKEN")
      expect(keyMaterial).not.toContain("top-secret")
      expect(process.env["PROJECT_CACHE_TOKEN"]).toBe("top-secret")
    } finally {
      delete process.env["PROJECT_CACHE_TOKEN"]
    }
  })
})

describe("planner ambient inputs", () => {
  it.skipIf(process.platform === "win32")("refuses a lockfile link that leaves the workspace", async () => {
    const outside = `${root}-outside-lockfile`
    await Fs.writeFile(outside, "lockfileVersion: '9.0'\n", "utf8")
    try {
      await Fs.symlink(outside, NodePath.join(root, "pnpm-lock.yaml"))
      await write(
        "BUILD.ts",
        `import { DepsLint, file, glob, PackageManager, Runtime } from "${
          NodePath.resolve(import.meta.dirname, "../../targets/src/Smithers.ts")
        }"\n` +
          toolchain +
          "export const lint = DepsLint({\n" +
          "  runtime,\n" +
          "  packageManager,\n" +
          "  packageJson: file(\"package.json\"),\n" +
          "  sources: [glob(\"src/**/*.ts\")],\n" +
          "  deps: [],\n" +
          "  tool: \"knip\",\n" +
          "  ignoreDependencies: [],\n" +
          "  ignoreBinaries: [],\n" +
          "  cwd: \".\"\n" +
          "})\n"
      )
      await write("package.json", "{}\n")
      await write("src/index.ts", "export const value = 1\n")

      await expect(Planner.make(await Workspace.make(root, root), "lint", "//:lint"))
        .rejects.toThrow(/symbolic link leaving the workspace/)
    } finally {
      await Fs.rm(outside, { force: true })
    }
  })
})

describe("ensureGitignored", () => {
  it("creates the file when it is absent", async () => {
    await ensureGitignored(root, ".flows")
    expect(await read(".gitignore")).toBe("/.flows/\n")
  })

  it("appends to an existing file without a trailing newline", async () => {
    await write(".gitignore", "/dist/")
    await ensureGitignored(root, "build/cache")
    expect(await read(".gitignore")).toBe("/dist/\n/build/cache/\n")
  })

  it("is idempotent", async () => {
    await ensureGitignored(root, ".flows")
    await ensureGitignored(root, ".flows")
    await ensureGitignored(root, ".flows")
    expect(await read(".gitignore")).toBe("/.flows/\n")
  })

  it("accepts an equivalent entry that is already present", async () => {
    for (const entry of [".flows", ".flows/", "/.flows", "  /.flows/  "]) {
      await write(".gitignore", `# header\n${entry}\n`)
      await ensureGitignored(root, ".flows")
      expect(await read(".gitignore")).toBe(`# header\n${entry}\n`)
    }
  })

  it("escapes gitignore pattern characters in a directory name", async () => {
    await ensureGitignored(root, "cache[1]")
    expect(await read(".gitignore")).toBe("/cache\\[1\\]/\n")
    await ensureGitignored(root, "cache[1]")
    expect(await read(".gitignore")).toBe("/cache\\[1\\]/\n")
  })

  it("refuses an invalid directory", async () => {
    await expect(ensureGitignored(root, "../escape")).rejects.toThrow(/must not leave the workspace/)
  })

  it("preserves the permission bits of an existing file", async () => {
    await write(".gitignore", "/dist/\n")
    await Fs.chmod(NodePath.join(root, ".gitignore"), 0o640)
    await ensureGitignored(root, ".flows")
    const stats = await Fs.lstat(NodePath.join(root, ".gitignore"))
    expect(stats.mode & 0o777).toBe(0o640)
    expect(await read(".gitignore")).toBe("/dist/\n/.flows/\n")
  })

  /**
   * The regression: every read failure was caught and treated as "there is no
   * .gitignore". A file this process could not read was therefore replaced by
   * one holding the entry alone, silently discarding whatever it held. Only
   * ENOENT means absent now.
   */
  it("fails instead of overwriting a file it cannot read", async () => {
    if (process.getuid?.() === 0) return
    await write(".gitignore", "/dist/\n")
    const path = NodePath.join(root, ".gitignore")
    await Fs.chmod(path, 0o000)
    try {
      await expect(ensureGitignored(root, ".flows")).rejects.toMatchObject({ code: "EACCES" })
      await Fs.chmod(path, 0o600)
      expect(await read(".gitignore")).toBe("/dist/\n")
    } finally {
      await Fs.chmod(path, 0o600).catch(() => undefined)
    }
  })

  it("refuses a .gitignore that is a symbolic link out of the workspace", async () => {
    const outside = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-outside-"))
    try {
      const target = NodePath.join(outside, "victim")
      await Fs.writeFile(target, "not ours\n", "utf8")
      await Fs.symlink(target, NodePath.join(root, ".gitignore"))

      await expect(ensureGitignored(root, ".flows")).rejects.toThrow(/symbolic link/)
      // The file the link pointed at is untouched, byte for byte.
      expect(await Fs.readFile(target, "utf8")).toBe("not ours\n")
    } finally {
      await Fs.rm(outside, { recursive: true, force: true })
    }
  })

  it("refuses a .gitignore that is not a regular file", async () => {
    await Fs.mkdir(NodePath.join(root, ".gitignore"), { recursive: true })
    await expect(ensureGitignored(root, ".flows")).rejects.toThrow(/not a regular file/)
  })

  it("refuses an oversized or invalid UTF-8 .gitignore without replacing it", async () => {
    const path = NodePath.join(root, ".gitignore")
    const oversized = Buffer.alloc(maximumGitignoreBytes + 1, 0x61)
    await Fs.writeFile(path, oversized)
    await expect(ensureGitignored(root, ".flows")).rejects.toThrow(/byte limit/)
    expect((await Fs.stat(path)).size).toBe(oversized.byteLength)

    const invalid = Buffer.from([0xc3, 0x28])
    await Fs.writeFile(path, invalid)
    await expect(ensureGitignored(root, ".flows")).rejects.toThrow(/not valid UTF-8/)
    expect(await Fs.readFile(path)).toEqual(invalid)
  })

  it.skipIf(process.platform === "win32")("refuses a hard-linked .gitignore", async () => {
    const original = NodePath.join(root, "shared-ignore")
    await Fs.writeFile(original, "/dist/\n", "utf8")
    await Fs.link(original, NodePath.join(root, ".gitignore"))

    await expect(ensureGitignored(root, ".flows")).rejects.toThrow(/hard-linked/)
    expect(await Fs.readFile(original, "utf8")).toBe("/dist/\n")
  })

  /**
   * Read-modify-write with no compare-and-swap: the last rename wins. Because
   * every writer derives the same contents from the same base, the loser's
   * result is byte-identical to the winner's, and publication is atomic, so no
   * reader can ever observe a partial or interleaved file.
   */
  it("never publishes a partial file under concurrent invocation", async () => {
    await write(".gitignore", "/dist/\n")
    const reads: Array<Promise<string>> = []
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        await ensureGitignored(root, ".flows")
        reads.push(read(".gitignore"))
      })
    )
    for (const text of await Promise.all(reads)) {
      expect(["/dist/\n", "/dist/\n/.flows/\n"]).toContain(text)
    }
    expect(await read(".gitignore")).toBe("/dist/\n/.flows/\n")
    // No temporary file survived any of the eight writers.
    expect((await Fs.readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })
})

describe("discoverable", () => {
  it("drops the cache directory from a git listing", () => {
    const listed = [
      "src/index.ts",
      ".flows/cache/ab/entry.json",
      ".flows",
      ".flowsy/keep.ts",
      "node_modules/pkg/index.js",
      ""
    ]
    expect(discoverable(listed, ".flows")).toEqual([
      ".flowsy/keep.ts",
      "src/index.ts"
    ])
  })

  it("drops a configured cache directory and keeps .flows", () => {
    expect(discoverable([
      ".flows/kept.ts",
      ".flows/store/pnpm/index.json",
      "build/cache/entry.json",
      "src/a.ts"
    ], "build/cache"))
      .toEqual([".flows/kept.ts", "src/a.ts"])
  })
})

describe("Workspace.make", () => {
  it("excludes a configured cache directory from the git listing", async () => {
    gitResult.error = null
    gitResult.stdout = [
      "BUILD.ts",
      ".flows/kept.ts",
      ".flows/store/pnpm/index.json",
      "build/cache/entry.json",
      "node_modules/pkg/index.js",
      "src/index.ts",
      ""
    ].join("\0")
    const workspace = await Workspace.make(root, root, { cacheDirectory: "build/cache" })
    expect(workspace.files).toEqual([".flows/kept.ts", "BUILD.ts", "src/index.ts"])
  })

  it("refuses malformed NUL framing and duplicate Git paths", async () => {
    gitResult.error = null
    gitResult.stdout = "BUILD.ts"
    await expect(Workspace.make(root, root)).rejects.toThrow(/final NUL delimiter/)

    gitResult.stdout = "BUILD.ts\0BUILD.ts\0"
    await expect(Workspace.make(root, root)).rejects.toThrow(/more than once/)
  })

  it("refuses Git output containing text that cannot round-trip through UTF-8", async () => {
    gitResult.error = null
    gitResult.stdout = "BUILD.ts\uD800\0"
    await expect(Workspace.make(root, root)).rejects.toThrow(/not valid UTF-8/)
  })

  it("defaults the cache directory to .flows and excludes it from the fallback listing", async () => {
    await write("src/index.ts", "export const a = 1\n")
    await write(".flows/cache/ab/entry.json", "{}")
    const workspace = await Workspace.make(root, root)
    expect(workspace.cacheDirectory).toBe(".flows")
    expect(workspace.files).toEqual(["src/index.ts"])
  })

  it("excludes a configured cache directory from the fallback listing", async () => {
    await write("src/index.ts", "export const a = 1\n")
    await write("build/cache/entry.json", "{}")
    await write(".flows/kept.ts", "export const kept = 1\n")
    await write(".flows/store/pnpm/index.json", "{}")
    const workspace = await Workspace.make(root, root, { cacheDirectory: "build/cache/" })
    expect(workspace.cacheDirectory).toBe("build/cache")
    expect(workspace.files).toEqual([".flows/kept.ts", "src/index.ts"])
  })

  it("excludes the cache directory even when the workspace does not ignore it", async () => {
    await write(".gitignore", "/dist/\n")
    await write("dist/out.js", "")
    await write(".flows/cache/entry.json", "{}")
    await write("BUILD.ts", "export const nothing = 1\n")
    const workspace = await Workspace.make(root, root)
    expect(workspace.files).toEqual([".gitignore", "BUILD.ts"])
  })

  it("refuses an invalid cache directory", async () => {
    await expect(Workspace.make(root, root, { cacheDirectory: "../escape" }))
      .rejects.toThrow(/must not leave the workspace/)
  })

  it("keeps the resolved directory out of target cache keys", async () => {
    await write(
      "BUILD.ts",
      `import { DepsLint, file, glob, PackageManager, Runtime } from "${
        NodePath.resolve(import.meta.dirname, "../../targets/src/Smithers.ts")
      }"\n` +
        toolchain +
        "export const lint = DepsLint({\n" +
        "  runtime,\n" +
        "  packageManager,\n" +
        "  packageJson: file(\"package.json\"),\n" +
        "  sources: [glob(\"src/**/*.ts\")],\n" +
        "  deps: [],\n" +
        "  tool: \"knip\",\n" +
        "  ignoreDependencies: [\"unused\"],\n" +
        "  ignoreBinaries: [],\n" +
        "  cwd: \".\"\n" +
        "})\n"
    )
    await write("package.json", "{}\n")
    await write("src/index.ts", "export const value = 1\n")
    const first = await Planner.make(
      await Workspace.make(root, root, { cacheDirectory: "first/cache" }),
      "lint",
      "//:lint"
    )
    const second = await Planner.make(
      await Workspace.make(root, root, { cacheDirectory: "second/cache" }),
      "lint",
      "//:lint"
    )
    expect(first.targets[0]?.keyPreview).toBe(second.targets[0]?.keyPreview)
    expect(JSON.stringify(first.targets[0]?.keyMaterial)).not.toContain("first/cache")
    expect(JSON.stringify(second.targets[0]?.keyMaterial)).not.toContain("second/cache")
  })
})

describe("isGitPath", () => {
  it("accepts the workspace-relative paths git actually reports", () => {
    for (const path of ["a.ts", "src/index.ts", "a b/c.ts", "packages/a/BUILD.ts", ".gitignore"]) {
      expect(isGitPath(path)).toBe(true)
    }
  })

  /**
   * git reports paths relative to the repository root, and `-z` output is
   * never quoted, so none of these is a path git found in this workspace.
   * Joining one to the root would name a file outside it, and that file would
   * then be digested into key material or imported as a BUILD.ts module.
   */
  it("refuses anything that is not one", () => {
    for (
      const path of [
        "",
        "/etc/passwd",
        "../outside.ts",
        "src/../../outside.ts",
        "src/./index.ts",
        "src//index.ts",
        "src\\index.ts",
        "C:\\Windows\\system32",
        "src/index.ts\0/etc/passwd"
      ]
    ) {
      expect(isGitPath(path)).toBe(false)
    }
  })
})

describe("discoverable path validation", () => {
  it("fails the whole listing rather than filtering a bad entry out of it", () => {
    expect(() => discoverable(["src/a.ts", "../escape.ts"], ".flows"))
      .toThrow(/git listed a path the workspace cannot use/)
    expect(() => discoverable(["/etc/passwd"], ".flows")).toThrow(/cannot use/)
    expect(() => discoverable(["a\0b"], ".flows")).toThrow(/cannot use/)
  })
})

describe("git failure handling", () => {
  /**
   * The regression: every git failure fell back to a filesystem walk. A
   * repository this process could not read therefore produced a listing that
   * looked fine and was missing files, and a workspace missing files plans and
   * caches as though those files had been deleted.
   */
  it("reports a git failure the fallback cannot answer completely", async () => {
    await write("src/index.ts", "export const a = 1\n")
    gitResult.error = Object.assign(new Error("Command failed: git"), { code: 128 })
    gitResult.stderr = "fatal: unable to read tree object"
    await expect(Workspace.make(root, root)).rejects.toThrow(/unable to read tree object/)
  })

  it("reports a listing too large for the subprocess buffer", async () => {
    gitResult.error = Object.assign(new Error("stdout maxBuffer length exceeded"), {
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
    })
    await expect(Workspace.make(root, root)).rejects.toThrow(/maxBuffer/)
  })

  it("falls back when the directory is not a git worktree", async () => {
    await write("src/index.ts", "export const a = 1\n")
    gitResult.error = notARepository()
    gitResult.stderr = "fatal: not a git repository (or any of the parent directories): .git"
    const workspace = await Workspace.make(root, root)
    expect(workspace.files).toEqual(["src/index.ts"])
  })

  it("falls back when git is not installed", async () => {
    await write("src/index.ts", "export const a = 1\n")
    gitResult.error = gitMissing()
    const workspace = await Workspace.make(root, root)
    expect(workspace.files).toEqual(["src/index.ts"])
  })

  /**
   * git applies a `.gitignore` in every directory. A fallback that read the
   * root file alone listed files git would never have reported, so the two
   * discovery paths disagreed about what the workspace held.
   */
  it("honors nested .gitignore files in the fallback listing", async () => {
    await write(".gitignore", "/generated/\n")
    await write("generated/out.ts", "export const out = 1\n")
    await write("packages/a/.gitignore", "dist/\n")
    await write("packages/a/dist/bundle.ts", "export const bundle = 1\n")
    await write("packages/a/src/index.ts", "export const a = 1\n")
    const workspace = await Workspace.make(root, root)
    expect(workspace.files).toEqual([
      ".gitignore",
      "packages/a/.gitignore",
      "packages/a/src/index.ts"
    ])
  })
})

describe("BUILD.ts admission", () => {
  /**
   * The regression: `stat(...).catch(() => false)` answered "there is no
   * BUILD.ts" for every failure. A workspace whose root declaration this
   * process could not read silently ran under the default configuration.
   */
  it("fails on a root BUILD.ts it cannot read", async () => {
    if (process.getuid?.() === 0) return
    await write("BUILD.ts", buildFile(`{ cacheDirectory: "build/cache" }`))
    const path = NodePath.join(root, "BUILD.ts")
    await Fs.chmod(path, 0o000)
    try {
      await expect(resolveConfig(root)).rejects.toMatchObject({ code: "EACCES" })
    } finally {
      await Fs.chmod(path, 0o600).catch(() => undefined)
    }
  })

  it("fails on a BUILD.ts that is a directory", async () => {
    await Fs.mkdir(NodePath.join(root, "BUILD.ts"), { recursive: true })
    await expect(resolveConfig(root)).rejects.toThrow(/not a regular file/)
    await expect(resolveRemoteCache(root)).rejects.toThrow(/not a regular file/)
  })

  /**
   * Importing a BUILD.ts evaluates it. A link is therefore a way to make a
   * workspace run a module it does not contain, which is exactly the thing the
   * trust statement says an admitted BUILD.ts is not.
   */
  it("never imports a BUILD.ts through a link out of the workspace", async () => {
    const outside = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-outside-"))
    try {
      const target = NodePath.join(outside, "BUILD.ts")
      await Fs.writeFile(target, buildFile(`{ cacheDirectory: "theirs" }`), "utf8")
      await Fs.symlink(target, NodePath.join(root, "BUILD.ts"))
      await expect(resolveConfig(root)).rejects.toThrow(/symbolic link leaving the workspace/)
    } finally {
      await Fs.rm(outside, { recursive: true, force: true })
    }
  })

  it("admits a BUILD.ts link that stays inside the workspace", async () => {
    await write("build/root.build.ts", buildFile(`{ cacheDirectory: "linked/cache" }`))
    await Fs.symlink(NodePath.join(root, "build/root.build.ts"), NodePath.join(root, "BUILD.ts"))
    expect(await resolveConfig(root)).toEqual({ cacheDirectory: "linked/cache", gitignored: false })
  })
})

describe("module namespace cache", () => {
  /**
   * The cache is process-global and a library caller runs more than one
   * command in one process. Keying it on the path string alone replayed the
   * first command's declarations after the file had been rewritten, and would
   * have merged two different files that happened to share a path spelling.
   */
  it("re-evaluates a BUILD.ts that changed between two commands", async () => {
    const workspace = NodePath.join(root, "ws")
    await Fs.mkdir(workspace, { recursive: true })
    const path = NodePath.join(workspace, "BUILD.ts")
    await Fs.writeFile(path, buildFile(`{ cacheDirectory: "first/cache" }`), "utf8")
    expect(await resolveConfig(workspace)).toEqual({ cacheDirectory: "first/cache", gitignored: false })

    const before = await Fs.stat(path)
    await Fs.writeFile(path, buildFile(`{ cacheDirectory: "other/cache" }`), "utf8")
    await Fs.utimes(path, before.atime, before.mtime)
    expect(await resolveConfig(workspace)).toEqual({
      cacheDirectory: "other/cache",
      gitignored: false
    })
  })

  it("never shares a module between two workspaces that share a path spelling", async () => {
    const workspace = NodePath.join(root, "ws")
    await Fs.mkdir(workspace, { recursive: true })
    await Fs.writeFile(
      NodePath.join(workspace, "BUILD.ts"),
      buildFile(`{ cacheDirectory: "one/cache" }`),
      "utf8"
    )
    expect(await resolveConfig(workspace)).toEqual({ cacheDirectory: "one/cache", gitignored: false })

    // A second, unrelated workspace occupies the same path. Nothing about the
    // string it is addressed by says which files it holds.
    await Fs.rm(workspace, { recursive: true, force: true })
    await Fs.mkdir(workspace, { recursive: true })
    await Fs.writeFile(
      NodePath.join(workspace, "BUILD.ts"),
      buildFile(`{ cacheDirectory: "two/cache" }`),
      "utf8"
    )
    expect(await resolveConfig(workspace)).toEqual({ cacheDirectory: "two/cache", gitignored: false })
  })

  it("keeps one evaluation, and one target identity, within one command", async () => {
    await write(
      "BUILD.ts",
      `import { DepsLint, file, glob, PackageManager, Runtime } from "${
        NodePath.resolve(import.meta.dirname, "../../targets/src/Smithers.ts")
      }"\n` +
        `import { Workspace } from "${NodePath.resolve(import.meta.dirname, "../../targets/src/Config.ts")}"\n` +
        toolchain +
        "export const config = Workspace({ cacheDirectory: \"one/cache\" })\n" +
        "export const lint = DepsLint({\n" +
        "  runtime,\n" +
        "  packageManager,\n" +
        "  packageJson: file(\"package.json\"),\n" +
        "  sources: [glob(\"src/**/*.ts\")],\n" +
        "  deps: [],\n" +
        "  tool: \"knip\",\n" +
        "  ignoreDependencies: [],\n" +
        "  ignoreBinaries: [],\n" +
        "  cwd: \".\"\n" +
        "})\n"
    )
    await write("package.json", "{}\n")
    await write("src/index.ts", "export const value = 1\n")
    const config = await resolveConfig(root)
    const workspace = await Workspace.make(root, root, { cacheDirectory: config.cacheDirectory })
    const [target] = await workspace.targets("//:lint")
    expect(await workspace.label(target!)).toBe("//:lint")
  })
})

describe("declared input confinement", () => {
  it("refuses a declared file that is a link out of the workspace", async () => {
    const outside = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-outside-"))
    try {
      await Fs.writeFile(NodePath.join(outside, "secret.ts"), "not ours\n", "utf8")
      await Fs.symlink(NodePath.join(outside, "secret.ts"), NodePath.join(root, "escape.ts"))
      await write(
        "BUILD.ts",
        `import { DepsLint, file, glob, PackageManager, Runtime } from "${
          NodePath.resolve(import.meta.dirname, "../../targets/src/Smithers.ts")
        }"\n` +
          toolchain +
          "export const lint = DepsLint({\n" +
          "  runtime,\n" +
          "  packageManager,\n" +
          "  packageJson: file(\"escape.ts\"),\n" +
          "  sources: [glob(\"src/**/*.ts\")],\n" +
          "  deps: [],\n" +
          "  tool: \"knip\",\n" +
          "  ignoreDependencies: [],\n" +
          "  ignoreBinaries: [],\n" +
          "  cwd: \".\"\n" +
          "})\n"
      )
      await write("src/index.ts", "export const value = 1\n")
      const workspace = await Workspace.make(root, root)
      await expect(Planner.make(workspace, "lint", "//:lint"))
        .rejects.toThrow(/symbolic link leaving the workspace/)
    } finally {
      await Fs.rm(outside, { recursive: true, force: true })
    }
  })
})
