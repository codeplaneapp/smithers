import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { openCache } from "../src/Cache.ts"
import {
  ClosureError,
  computeClosure,
  expandAnchoredSources,
  extractSpecifiers,
  loadResolverConfig,
  maximumModuleBytes,
  packageDirectoryOf,
  ResolverConfigError,
  resolveSpecifier,
  type TreeView
} from "../src/Resolver.ts"

let root: string

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

const closureOf = async (
  entries: ReadonlyArray<string>,
  options?: { readonly tsconfig?: string }
) => {
  const config = await loadResolverConfig({ workspaceRoot: root, tsconfig: options?.tsconfig })
  return computeClosure({ config, entries })
}

const paths = (outcome: Awaited<ReturnType<typeof closureOf>>): ReadonlyArray<string> =>
  outcome.result.files.map((file) => file.path)

beforeEach(async () => {
  root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-resolver-"))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("extractSpecifiers", () => {
  it("extracts every static import form", () => {
    const found = extractSpecifiers(
      "a.ts",
      [
        `import { a } from "./a"`,
        `import type { T } from "./types"`,
        `export { b } from "./b"`,
        `export * from "./c"`,
        `import legacy = require("./legacy")`,
        `const d = require("./d")`,
        `const e = require.resolve("./e")`,
        `const f = await import("./f")`,
        "const g = await import(`./g`)"
      ].join("\n")
    )
    expect(found).toEqual([
      { specifier: "./a", dynamic: false },
      { specifier: "./types", dynamic: false },
      { specifier: "./b", dynamic: false },
      { specifier: "./c", dynamic: false },
      { specifier: "./legacy", dynamic: false },
      { specifier: "./d", dynamic: false },
      { specifier: "./e", dynamic: false },
      { specifier: "./f", dynamic: false },
      { specifier: "./g", dynamic: false }
    ])
  })

  it("marks computed import arguments dynamic with bounded text", () => {
    const found = extractSpecifiers(
      "a.ts",
      `const name = "x"\nconst a = await import("./pages/" + name)\nconst b = require(name)\n`
    )
    expect(found).toEqual([
      { specifier: `"./pages/" + name`, dynamic: true },
      { specifier: "name", dynamic: true }
    ])
  })

  it("recovers sites from a file with syntax errors", () => {
    const found = extractSpecifiers("a.ts", `import { a } from "./a"\nconst broken = {{{\n`)
    expect(found).toEqual([{ specifier: "./a", dynamic: false }])
  })
})

describe("relative resolution", () => {
  it("computes the closure over relative imports with extension probing", async () => {
    await write("src/entry.ts", `import "./a"\nimport "./b.js"\nimport "./nested"\n`)
    await write("src/a.ts", `export const a = 1\n`)
    await write("src/b.ts", `import "../shared/c"\nexport const b = 1\n`)
    await write("shared/c.tsx", `export const c = 1\n`)
    await write("src/nested/index.ts", `export const nested = 1\n`)
    const outcome = await closureOf(["src/entry.ts"])
    expect(paths(outcome)).toEqual([
      "shared/c.tsx",
      "src/a.ts",
      "src/b.ts",
      "src/entry.ts",
      "src/nested/index.ts"
    ])
    expect(outcome.result.packages).toEqual([])
    expect(outcome.result.unresolved).toEqual([])
    expect(outcome.result.dynamic).toEqual([])
    for (const file of outcome.result.files) {
      expect(file.digest).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it("maps JavaScript-suffixed specifiers onto TypeScript siblings first", async () => {
    await write("entry.ts", `import "./real.js"\nimport "./only-js.js"\n`)
    await write("real.ts", `export const real = 1\n`)
    await write("only-js.js", `module.exports = 1\n`)
    const outcome = await closureOf(["entry.ts"])
    expect(paths(outcome)).toEqual(["entry.ts", "only-js.js", "real.ts"])
  })

  it("carries a missing relative import as an explicit unresolved row", async () => {
    await write("entry.ts", `import "./gone"\n`)
    const outcome = await closureOf(["entry.ts"])
    expect(paths(outcome)).toEqual(["entry.ts"])
    expect(outcome.result.unresolved).toEqual([{ file: "entry.ts", specifier: "./gone" }])
  })

  it("keeps a dynamic-expression import as an explicit dynamic row", async () => {
    await write("entry.ts", `const name = "a"\nexport const load = () => import("./pages/" + name)\n`)
    const outcome = await closureOf(["entry.ts"])
    expect(outcome.result.dynamic).toEqual([{ file: "entry.ts", specifier: `"./pages/" + name` }])
  })

  it("classifies node builtins with and without the node: prefix", async () => {
    await write("entry.ts", `import "node:path"\nimport "fs"\nimport "fs/promises"\n`)
    const outcome = await closureOf(["entry.ts"])
    expect(paths(outcome)).toEqual(["entry.ts"])
    expect(outcome.result.packages).toEqual([])
    expect(outcome.result.unresolved).toEqual([])
  })

  it("includes non-module leaves without parsing them", async () => {
    await write("entry.ts", `import data from "./data.json"\n`)
    await write("data.json", `{"a": 1}\n`)
    const outcome = await closureOf(["entry.ts"])
    expect(paths(outcome)).toEqual(["data.json", "entry.ts"])
  })

  it("handles import cycles as a fixed point", async () => {
    await write("a.ts", `import "./b"\nexport const a = 1\n`)
    await write("b.ts", `import "./a"\nexport const b = 1\n`)
    const outcome = await closureOf(["a.ts"])
    expect(paths(outcome)).toEqual(["a.ts", "b.ts"])
  })

  it("refuses a missing entry loudly", async () => {
    await expect(closureOf(["gone.ts"])).rejects.toThrow(ClosureError)
  })

  it("refuses an entry that escapes the workspace", async () => {
    await expect(closureOf(["../outside.ts"])).rejects.toThrow(ClosureError)
  })
})

describe("cjs resolution", () => {
  it("follows require chains", async () => {
    await write("entry.cjs", `const a = require("./lib/a")\nrequire.resolve("./lib/b.cjs")\n`)
    await write("lib/a.cjs", `module.exports = require("./b.cjs")\n`)
    await write("lib/b.cjs", `module.exports = 1\n`)
    const outcome = await closureOf(["entry.cjs"])
    expect(paths(outcome)).toEqual(["entry.cjs", "lib/a.cjs", "lib/b.cjs"])
  })
})

describe("tsconfig paths resolution", () => {
  it("resolves paths patterns and baseUrl fallbacks", async () => {
    await write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@lib/*": ["src/lib/*"], "@exact": ["src/exact.ts"] }
        }
      })
    )
    await write("entry.ts", `import "@lib/util"\nimport "@exact"\nimport "src/base"\n`)
    await write("src/lib/util.ts", `export const util = 1\n`)
    await write("src/exact.ts", `export const exact = 1\n`)
    await write("src/base.ts", `export const base = 1\n`)
    const outcome = await closureOf(["entry.ts"])
    expect(paths(outcome)).toEqual([
      "entry.ts",
      "src/base.ts",
      "src/exact.ts",
      "src/lib/util.ts"
    ])
    expect(outcome.result.unresolved).toEqual([])
  })

  it("follows a relative extends chain with later files overriding", async () => {
    await write("tsconfig.base.json", JSON.stringify({ compilerOptions: { paths: { "@old/*": ["old/*"] } } }))
    await write(
      "tsconfig.json",
      JSON.stringify({
        extends: "./tsconfig.base.json",
        compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["src/lib/*"] } }
      })
    )
    await write("entry.ts", `import "@lib/util"\nimport "@old/thing"\n`)
    await write("src/lib/util.ts", `export const util = 1\n`)
    await write("old/thing.ts", `export const thing = 1\n`)
    const outcome = await closureOf(["entry.ts"])
    expect(paths(outcome)).toEqual(["entry.ts", "src/lib/util.ts"])
    expect(outcome.result.unresolved).toEqual([{ file: "entry.ts", specifier: "@old/thing" }])
  })

  it("refuses a non-relative extends form loudly", async () => {
    await write("tsconfig.json", JSON.stringify({ extends: "@tsconfig/node20" }))
    await expect(loadResolverConfig({ workspaceRoot: root })).rejects.toThrow(ResolverConfigError)
  })

  it("changes the config digest when the tsconfig changes", async () => {
    await write("tsconfig.json", JSON.stringify({ compilerOptions: {} }))
    const first = await loadResolverConfig({ workspaceRoot: root })
    await write("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: "." } }))
    const second = await loadResolverConfig({ workspaceRoot: root })
    expect(first.configDigest).not.toBe(second.configDigest)
  })
})

describe("package resolution", () => {
  it("resolves node_modules specifiers to package-level nodes", async () => {
    await write("entry.ts", `import "some-lib"\nimport "@scope/pkg"\nimport "@scope/pkg/deep/file"\n`)
    await write("node_modules/some-lib/package.json", JSON.stringify({ name: "some-lib", main: "index.js" }))
    await write("node_modules/some-lib/index.js", `module.exports = 1\n`)
    await write(
      "node_modules/@scope/pkg/package.json",
      JSON.stringify({ name: "@scope/pkg", exports: { ".": "./index.js", "./deep/*": "./dist/deep/*.js" } })
    )
    const outcome = await closureOf(["entry.ts"])
    expect(paths(outcome)).toEqual(["entry.ts"])
    expect(outcome.result.packages).toEqual(["@scope/pkg", "some-lib"])
    expect(outcome.result.unresolved).toEqual([])
  })

  it("marks a subpath the exports map blocks as unresolved", async () => {
    await write("entry.ts", `import "walled/secret"\n`)
    await write(
      "node_modules/walled/package.json",
      JSON.stringify({ name: "walled", exports: { ".": "./index.js" } })
    )
    const outcome = await closureOf(["entry.ts"])
    expect(outcome.result.packages).toEqual([])
    expect(outcome.result.unresolved).toEqual([{ file: "entry.ts", specifier: "walled/secret" }])
  })

  it("marks a missing package as unresolved", async () => {
    await write("entry.ts", `import "never-installed"\n`)
    const outcome = await closureOf(["entry.ts"])
    expect(outcome.result.unresolved).toEqual([{ file: "entry.ts", specifier: "never-installed" }])
  })

  it("finds packages in ancestor node_modules from a nested importer", async () => {
    await write("packages/app/src/entry.ts", `import "hoisted"\n`)
    await write("node_modules/hoisted/package.json", JSON.stringify({ name: "hoisted", main: "index.js" }))
    const outcome = await closureOf(["packages/app/src/entry.ts"])
    expect(outcome.result.packages).toEqual(["hoisted"])
  })
})

describe("resolveSpecifier statuses", () => {
  it("covers all five statuses over one tree", async () => {
    await write("a.ts", `export const a = 1\n`)
    await write("node_modules/dep/package.json", JSON.stringify({ name: "dep" }))
    const config = await loadResolverConfig({ workspaceRoot: root })
    const view: TreeView = {
      root,
      async kind(relativePath) {
        try {
          const stat = await Fs.stat(NodePath.join(root, relativePath))
          return stat.isFile() ? "file" : stat.isDirectory() ? "dir" : "other"
        } catch {
          return null
        }
      }
    }
    const resolve = (specifier: string, dynamic = false) =>
      resolveSpecifier(config, view, "a.ts", { specifier, dynamic })
    await expect(resolve("./a")).resolves.toEqual({ specifier: "./a", status: "resolved-file", resolved: "a.ts" })
    await expect(resolve("dep")).resolves.toEqual({ specifier: "dep", status: "package", packageName: "dep" })
    await expect(resolve("node:url")).resolves.toEqual({ specifier: "node:url", status: "builtin" })
    await expect(resolve("./gone")).resolves.toEqual({ specifier: "./gone", status: "unresolved" })
    await expect(resolve("x + y", true)).resolves.toEqual({ specifier: "x + y", status: "dynamic" })
    await expect(resolve("/etc/passwd")).resolves.toEqual({ specifier: "/etc/passwd", status: "unresolved" })
    await expect(resolve("../../outside")).resolves.toEqual({ specifier: "../../outside", status: "unresolved" })
  })
})

describe("row caching", () => {
  const cachedClosure = async () => {
    const config = await loadResolverConfig({ workspaceRoot: root })
    const cache = await openCache({ workspaceRoot: root })
    try {
      return await computeClosure({ config, entries: ["entry.ts"], cache })
    } finally {
      await cache.close()
    }
  }

  it("re-parses exactly the edited file on the next run", async () => {
    await write("entry.ts", `import "./a"\nimport "./b"\n`)
    await write("a.ts", `export const a = 1\n`)
    await write("b.ts", `export const b = 1\n`)

    const first = await cachedClosure()
    expect(first.stats).toEqual({ parsed: 3, cached: 0 })

    const second = await cachedClosure()
    expect(second.stats).toEqual({ parsed: 0, cached: 3 })
    expect(JSON.stringify(second.result)).toBe(JSON.stringify(first.result))

    await write("a.ts", `export const a = 2\n`)
    const third = await cachedClosure()
    expect(third.stats).toEqual({ parsed: 1, cached: 2 })
  })

  it("re-resolves cached rows against the current tree", async () => {
    await write("entry.ts", `import "./maybe"\n`)
    const first = await cachedClosure()
    expect(first.result.unresolved).toEqual([{ file: "entry.ts", specifier: "./maybe" }])

    // The row for entry.ts is cached, but creating maybe.ts changes what
    // "./maybe" means; the closure must see it without re-parsing.
    await write("maybe.ts", `export const maybe = 1\n`)
    const second = await cachedClosure()
    expect(second.stats.cached).toBe(1)
    expect(second.result.unresolved).toEqual([])
    expect(paths(second)).toEqual(["entry.ts", "maybe.ts"])
  })
})

describe("determinism", () => {
  it("produces byte-identical results across runs and cache states", async () => {
    await write("entry.ts", `import "./z"\nimport "./a"\nimport "missing-pkg"\nimport("./x" + "?")\n`)
    await write("z.ts", `import "./a"\n`)
    await write("a.ts", `export const a = 1\n`)
    const config = await loadResolverConfig({ workspaceRoot: root })
    const cache = await openCache({ workspaceRoot: root })
    try {
      const cold = await computeClosure({ config, entries: ["entry.ts"], cache })
      const warm = await computeClosure({ config, entries: ["entry.ts"], cache })
      const uncached = await computeClosure({ config, entries: ["entry.ts"] })
      expect(JSON.stringify(warm.result)).toBe(JSON.stringify(cold.result))
      expect(JSON.stringify(uncached.result)).toBe(JSON.stringify(cold.result))
    } finally {
      await cache.close()
    }
  })

  it("enforces the closure size bound loudly", async () => {
    await write("entry.ts", `import "./a"\n`)
    await write("a.ts", `export const a = 1\n`)
    const config = await loadResolverConfig({ workspaceRoot: root })
    await expect(computeClosure({ config, entries: ["entry.ts"], maximumFiles: 1 })).rejects.toThrow(
      /exceeds 1 files/
    )
  })

  it("sorts multiple issues by file then specifier", async () => {
    await write("entry.ts", `import "./z-first"\nimport "./a-first"\nimport "./sub"\n`)
    await write("sub.ts", `import "./also-gone"\n`)
    const outcome = await closureOf(["entry.ts"])
    expect(outcome.result.unresolved).toEqual([
      { file: "entry.ts", specifier: "./a-first" },
      { file: "entry.ts", specifier: "./z-first" },
      { file: "sub.ts", specifier: "./also-gone" }
    ])
  })
})

describe("edges and bounds", () => {
  it("resolves #imports through the nearest package.json imports map", async () => {
    await write("package.json", JSON.stringify({ imports: { "#lib/*": "./src/lib/*.js", "#one": "./one.js" } }))
    await write("entry.ts", `import "#lib/util"\nimport "#one"\nimport "#nope"\n`)
    const outcome = await closureOf(["entry.ts"])
    expect(outcome.result.packages).toEqual(["#lib/util", "#one"])
    expect(outcome.result.unresolved).toEqual([{ file: "entry.ts", specifier: "#nope" }])
    const config = await loadResolverConfig({ workspaceRoot: root })
    const view: TreeView = {
      root,
      async kind(relativePath) {
        try {
          const stat = await Fs.stat(NodePath.join(root, relativePath))
          return stat.isFile() ? "file" : stat.isDirectory() ? "dir" : "other"
        } catch {
          return null
        }
      }
    }
    await expect(resolveSpecifier(config, view, "entry.ts", { specifier: "#lib/util", dynamic: false }))
      .resolves.toEqual({ specifier: "#lib/util", status: "package", packageName: "#lib/util" })
  })

  it("classifies symlinked files and broken links", async () => {
    await write("real.ts", `export const real = 1\n`)
    await Fs.symlink("real.ts", NodePath.join(root, "link.ts"))
    await Fs.symlink("gone.ts", NodePath.join(root, "broken.ts"))
    await write("entry.ts", `import "./link"\nimport "./broken"\n`)
    const outcome = await closureOf(["entry.ts"])
    expect(paths(outcome)).toEqual(["entry.ts", "link.ts"])
    expect(outcome.result.unresolved).toEqual([{ file: "entry.ts", specifier: "./broken" }])
  })

  it("drops or refuses missing declared entry files by requireFiles", async () => {
    await write("present.ts", `export const present = 1\n`)
    const sources = [
      { base: "", source: { _tag: "File", path: "present.ts" } as const },
      { base: "", source: { _tag: "File", path: "absent.ts" } as const }
    ]
    await expect(expandAnchoredSources({ workspaceRoot: root, sources, requireFiles: false }))
      .resolves.toEqual(["present.ts"])
    await expect(expandAnchoredSources({ workspaceRoot: root, sources, requireFiles: true }))
      .rejects.toThrow(/declared entry file does not exist: absent.ts/)
  })

  it("keeps declaration modules out of source globs but admits explicit files", async () => {
    await write("src.ts", "export const value = 1\n")
    await write("PACKAGE.ts", "export const Package = {}\n")
    await write("WORKSPACE.ts", "export const Workspace = {}\n")
    const glob = { base: "", source: { _tag: "Glob", pattern: "**/*.ts", exclude: [] } as const }
    await expect(expandAnchoredSources({ workspaceRoot: root, sources: [glob], requireFiles: true }))
      .resolves.toEqual(["src.ts"])
    await expect(expandAnchoredSources({
      workspaceRoot: root,
      sources: [{ base: "", source: { _tag: "File", path: "PACKAGE.ts" } as const }],
      requireFiles: true
    })).resolves.toEqual(["PACKAGE.ts"])
  })

  it("maps an anchored base inside the workspace and refuses one outside", () => {
    expect(packageDirectoryOf(root, "")).toBe("")
    expect(packageDirectoryOf(root, root)).toBe("")
    expect(packageDirectoryOf(root, NodePath.join(root, "packages", "app"))).toBe("packages/app")
    expect(() => packageDirectoryOf(root, NodePath.dirname(root))).toThrow(ResolverConfigError)
  })

  it("treats a malformed package.json as a manifest-less package", async () => {
    await write("entry.ts", `import "broken-manifest"\n`)
    await write("node_modules/broken-manifest/package.json", "{not json")
    const outcome = await closureOf(["entry.ts"])
    expect(outcome.result.packages).toEqual(["broken-manifest"])
  })

  it("refuses an explicitly named missing tsconfig", async () => {
    await expect(loadResolverConfig({ workspaceRoot: root, tsconfig: "missing/tsconfig.json" }))
      .rejects.toThrow(ResolverConfigError)
  })

  it("refuses a tsconfig with invalid JSONC", async () => {
    await write("tsconfig.json", "{not valid jsonc")
    await expect(loadResolverConfig({ workspaceRoot: root })).rejects.toThrow(/not valid JSONC/)
  })

  it("refuses a baseUrl escaping the workspace", async () => {
    await write("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: "../.." } }))
    await expect(loadResolverConfig({ workspaceRoot: root })).rejects.toThrow(/outside the workspace/)
  })

  it("refuses malformed paths declarations loudly", async () => {
    await write("tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "@a/*": "src/*" } } }))
    await expect(loadResolverConfig({ workspaceRoot: root })).rejects.toThrow(/array of strings/)
    await write("tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "@a*b*": ["src/*"] } } }))
    await expect(loadResolverConfig({ workspaceRoot: root })).rejects.toThrow(/more than one \*/)
    await write("tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "@a/*": ["s*rc/*"] } } }))
    await expect(loadResolverConfig({ workspaceRoot: root })).rejects.toThrow(/more than one \*/)
    await write("tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "@a/*": ["../out/*"] } } }))
    await expect(loadResolverConfig({ workspaceRoot: root })).rejects.toThrow(/escapes the workspace/)
  })

  it("refuses an oversized module loudly", async () => {
    const oversized = Buffer.alloc(maximumModuleBytes + 1, 0x20)
    await Fs.writeFile(NodePath.join(root, "entry.ts"), oversized)
    const config = await loadResolverConfig({ workspaceRoot: root })
    await expect(computeClosure({ config, entries: ["entry.ts"] })).rejects.toThrow(/parse bound/)
  })

  it("strips query suffixes and a byte-order mark before resolving", async () => {
    await Fs.writeFile(NodePath.join(root, "entry.ts"), `﻿import "./a?raw"\n`, "utf8")
    await write("a.ts", `export const a = 1\n`)
    const outcome = await closureOf(["entry.ts"])
    expect(paths(outcome)).toEqual(["a.ts", "entry.ts"])
  })
})
