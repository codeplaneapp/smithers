/**
 * Packs publishable workspace tarballs without changing the Effect-style
 * source exports used by this repository.
 *
 * pnpm preserves `package.json#exports` when packing; it does not replace it
 * with `publishConfig.exports`. Each package intentionally follows Effect's
 * source-first manifest shape, so release packing happens from a temporary
 * copy whose exports are rewritten to the already-built ESM/CJS artifacts.
 */
import { spawn } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const packagesRoot = join(repoRoot, "packages")
const packageGroups = new Set(["engine", "agent", "tooling"])

/**
 * The groups the 1.0 release train packs.
 *
 * 0.x shipped the engine group alone and left the agent layer for a second
 * train. Smithers 1.0 gives every public first-party package one synchronized
 * version (PLAN.md "Versioning model"), so both groups release together.
 * `tooling` stays out: the build graph, its CLI, and the hosted cache are
 * private (rc-contract.md section 3.2).
 */
export const releaseGroups = new Set(["engine", "agent"])

/**
 * The package names published at 1.0.0-rc.0, from rc-contract.md section 3.1.
 *
 * Group membership alone would let a new or newly public package join the
 * release by declaring a group, and it would let a package leave by flipping
 * `private`. Both are release decisions, so the roster is restated here and
 * checked against what the workspace actually declares.
 */
export const publishedPackages = [
  "@smthrs/agent",
  "@smthrs/artifacts",
  "@smthrs/canonical",
  "@smthrs/capability",
  "@smthrs/cli",
  "@smthrs/control",
  "@smthrs/core",
  "@smthrs/crypto",
  "@smthrs/database",
  "@smthrs/engine",
  "@smthrs/engine-store",
  "@smthrs/flow",
  "@smthrs/flows",
  "@smthrs/gateway",
  "@smthrs/harness",
  "@smthrs/jj",
  "@smthrs/journal",
  "@smthrs/kernel",
  "@smthrs/keys",
  "@smthrs/mcp",
  "@smthrs/memory",
  "@smthrs/migrate",
  "@smthrs/model",
  "@smthrs/notifications",
  "@smthrs/observability",
  "@smthrs/patterns",
  "@smthrs/plan",
  "@smthrs/platform-browser",
  "@smthrs/platform-bun",
  "@smthrs/platform-node",
  "@smthrs/plugin",
  "@smthrs/registry",
  "@smthrs/run-store",
  "@smthrs/sandbox",
  "@smthrs/std",
  "@smthrs/step-cache",
  "@smthrs/sync",
  "@smthrs/testing",
  "@smthrs/time-travel",
  "smthrs"
]

/**
 * Reads every publishable workspace under `packages/`, keyed by directory name.
 *
 * Membership is derived from `smthrs.group` and `private`, then checked against
 * {@link publishedPackages}. Every manifest must declare a known group so a new
 * package cannot silently fall outside a release train. Directories a deleted
 * package left behind carry no manifest and are skipped.
 */
export const readWorkspaceManifests = (root = packagesRoot) => {
  const manifests = new Map()
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(root, entry.name, "package.json")
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    const group = manifest.smthrs?.group
    if (!packageGroups.has(group)) {
      throw new Error(`${manifestPath}: smthrs.group must be one of ${[...packageGroups].join(", ")}`)
    }
    if (manifest.private || !releaseGroups.has(group)) continue
    manifests.set(entry.name, manifest)
  }
  const declared = [...manifests.values()].map((manifest) => manifest.name).sort()
  const expected = [...publishedPackages].sort()
  const missing = expected.filter((name) => !declared.includes(name))
  const unexpected = declared.filter((name) => !expected.includes(name))
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      "the publishable workspace set does not match rc-contract.md section 3.1" +
        (missing.length > 0 ? `\n  missing: ${missing.join(", ")}` : "") +
        (unexpected.length > 0 ? `\n  unexpected: ${unexpected.join(", ")}` : "") +
        "\nEither restore the manifest's `private` flag and group or update publishedPackages in this file."
    )
  }
  return manifests
}

/**
 * Maps each workspace directory to the workspace directories it depends on.
 *
 * Only `@smthrs/*` edges resolving to a member of `manifests` are kept, so a
 * dependency on something outside the release set cannot order the release.
 */
export const workspaceDependencies = (manifests) => {
  const directoryOf = new Map(
    [...manifests].map(([directory, manifest]) => [manifest.name, directory])
  )
  return new Map([...manifests].map(([directory, manifest]) => [
    directory,
    new Set(
      Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })
        .map((dependency) => directoryOf.get(dependency))
        .filter((dependency) => dependency !== undefined)
    )
  ]))
}

const dependsOnItself = (node, dependencies, remaining) => {
  const pending = [...dependencies.get(node)].filter((edge) => remaining.has(edge))
  const seen = new Set()
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === node) return true
    if (seen.has(current)) continue
    seen.add(current)
    for (const edge of dependencies.get(current)) {
      if (remaining.has(edge)) pending.push(edge)
    }
  }
  return false
}

/**
 * Orders workspaces so a package follows every workspace dependency it declares.
 *
 * The graph is not acyclic. `@smthrs/kernel` publishes `kernel/test/TestHost`,
 * which imports `@smthrs/platform-browser`, and `platform-browser` imports
 * `@smthrs/kernel` back. So the order emits an unblocked workspace whenever one
 * exists, and otherwise enters the remaining cycle at its alphabetically first
 * member. Only a genuine cycle is ever broken; every other edge is respected.
 */
export const dependencyOrder = (dependencies) => {
  const remaining = new Set([...dependencies.keys()].sort())
  const ordered = []
  while (remaining.size > 0) {
    const unblocked = [...remaining].find((candidate) =>
      [...dependencies.get(candidate)].every((edge) => !remaining.has(edge))
    )
    // Every remaining workspace is blocked, so the remaining subgraph has an
    // out-edge everywhere and therefore contains a cycle to enter.
    const next = unblocked ??
      [...remaining].find((candidate) => dependsOnItself(candidate, dependencies, remaining))
    if (next === undefined) {
      throw new Error(`no orderable workspace among ${[...remaining].join(", ")}`)
    }
    ordered.push(next)
    remaining.delete(next)
  }
  return ordered
}

/**
 * Dependency order used for release packing and publication.
 */
export const workspaces = dependencyOrder(workspaceDependencies(readWorkspaceManifests()))

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Extracts the portable tarball name from pnpm's pack result.
 *
 * pnpm returns an absolute `filename` when `--pack-destination` is absolute,
 * while the release manifest deliberately stores names relative to its pack
 * directory so CI can move and publish that directory as one artifact.
 */
export const packResultFilename = (result, packageName) => {
  if (!isRecord(result) || typeof result.filename !== "string") {
    throw new Error(`pnpm pack returned no filename for ${String(packageName)}`)
  }
  return basename(result.filename)
}

/**
 * Produces the manifest that belongs in a registry tarball.
 */
export const publicationManifest = (manifest) => {
  if (!isRecord(manifest)) {
    throw new TypeError("package manifest must be an object")
  }
  const publishConfig = manifest.publishConfig
  if (!isRecord(publishConfig) || !isRecord(publishConfig.exports)) {
    throw new TypeError(`${String(manifest.name ?? "package")} must declare publishConfig.exports`)
  }
  const { exports, ...publishedConfig } = publishConfig
  return {
    ...manifest,
    exports,
    publishConfig: publishedConfig
  }
}

const sourceFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory()
      ? sourceFiles(path)
      : entry.name.endsWith(".ts") ? [path] : []
  }))
  return nested.flat()
}

/**
 * The modules a manifest publishes as ESM only: every `publishConfig.exports`
 * entry that names a concrete `dist/esm` file under `import` and declares no
 * `require` condition. `@smthrs/testing/Vitest` is one: `vitest` refuses to
 * load through `require()`, so the package's build program emits no
 * `dist/cjs/Vitest.js` and the export map is what tells consumers so. The
 * built-output check below reads the same map, so the two cannot disagree.
 */
export const esmOnlyModules = (manifest) => {
  const modules = new Set()
  for (const conditions of Object.values(manifest.publishConfig?.exports ?? {})) {
    if (typeof conditions !== "object" || conditions === null || "require" in conditions) continue
    const match = /^\.\/dist\/esm\/([^*]+)\.js$/.exec(conditions.import ?? "")
    if (match !== null) modules.add(match[1])
  }
  return modules
}

/**
 * Replaces every comment and template literal in `source` with spaces, one per
 * character, so a line-anchored regex sees only declarations and every offset
 * and line number still points at the original text. Quoted strings are kept,
 * because an import declaration's module specifier is one, but they are
 * tracked so a backtick inside `"```ts"` does not open a template.
 *
 * The scanner knows five states and nothing else: a `'` or `"` string ends at
 * its closing quote or at the end of its line, a template literal ends at its
 * closing backtick and nests through `${ }`, and a comment ends at the end of
 * its line or at the closing star-slash. Regular-expression literals are not
 * recognised, so an unescaped quote inside one costs at most the rest of its
 * own line and an unescaped backtick opens a template; neither occurs in a
 * published package today, and dprint escapes both.
 */
const declarationText = (source) => {
  const out = []
  // Brace depth inside each open `${ }` hole, innermost last. While a hole is
  // open the scanner is back in code, and the hole's closing brace returns it
  // to the template.
  const holes = []
  let state = "code"
  let i = 0
  const keep = (ch) => out.push(ch)
  const blank = (ch) => out.push(ch === "\n" ? "\n" : " ")
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    switch (state) {
      case "code": {
        if (ch === "/" && next === "/") {
          state = "line"
          blank(ch)
          blank(next)
          i += 2
        } else if (ch === "/" && next === "*") {
          state = "block"
          blank(ch)
          blank(next)
          i += 2
        } else if (ch === "'" || ch === "\"") {
          state = ch
          keep(ch)
          i += 1
        } else if (ch === "`") {
          state = "template"
          blank(ch)
          i += 1
        } else if (holes.length > 0 && ch === "{") {
          holes[holes.length - 1] += 1
          keep(ch)
          i += 1
        } else if (holes.length > 0 && ch === "}" && holes[holes.length - 1] === 0) {
          holes.pop()
          state = "template"
          blank(ch)
          i += 1
        } else if (holes.length > 0 && ch === "}") {
          holes[holes.length - 1] -= 1
          keep(ch)
          i += 1
        } else {
          keep(ch)
          i += 1
        }
        break
      }
      case "line": {
        if (ch === "\n") state = "code"
        blank(ch)
        i += 1
        break
      }
      case "block": {
        if (ch === "*" && next === "/") {
          state = "code"
          blank(ch)
          blank(next)
          i += 2
        } else {
          blank(ch)
          i += 1
        }
        break
      }
      case "'":
      case "\"": {
        if (ch === "\\" && next !== undefined) {
          keep(ch)
          keep(next)
          i += 2
        } else {
          if (ch === state || ch === "\n") state = "code"
          keep(ch)
          i += 1
        }
        break
      }
      case "template": {
        if (ch === "\\" && next !== undefined) {
          blank(ch)
          blank(next)
          i += 2
        } else if (ch === "`") {
          state = "code"
          blank(ch)
          i += 1
        } else if (ch === "$" && next === "{") {
          holes.push(0)
          state = "code"
          blank(ch)
          blank(next)
          i += 2
        } else {
          blank(ch)
          i += 1
        }
        break
      }
    }
  }
  return out.join("")
}

const defaultImportPattern =
  /^[ \t]*import\s+([A-Za-z_$][\w$]*)(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+[A-Za-z_$][\w$]*)\s*|\s+)from\s+["'](\.\.?\/[^"'\n]*)["']/gm
const defaultExportPattern = /^[ \t]*export\s+default\b/gm

/**
 * The default-binding sites in one TypeScript module: every default import of
 * a relative module (`import x from "./y.ts"`, with or without named or
 * namespace bindings beside it) and every `export default` declaration. Each
 * site carries the one-based `line`, its `kind`, and the original line `text`.
 *
 * Both are forbidden in a published package's `src`. `scripts/build.mjs`
 * converts every source file to CommonJS with esbuild (`bundle: false`) inside
 * a `"type": "module"` package, and for a default import of a sibling esbuild
 * emits Node-style interop: `__toESM(require("./y.js"), 1)` and then reads
 * `.default`, which in Node mode is the whole exports object
 * `{ __esModule, default }` rather than the exported value. A migration module
 * imported that way reached `initial.pipe(...)` at module init and threw in
 * the CommonJS entries of `@smthrs/control`, `@smthrs/gateway`, and
 * `@smthrs/cli`. `export default` alone is harmless to `require()`, but it is
 * the only thing a default import can bind to, so it is refused as well.
 *
 * Type-only imports (`import type x from "./y.ts"`) erase before the build and
 * are not reported. Bare and scoped specifiers (`import React from "react"`)
 * cross a package boundary where the interop is the consumer's, not ours, and
 * are not reported either. Comments and template literals are blanked before
 * matching, so a flow skeleton spelled inside a template string is not a site.
 */
export const defaultBindings = (source) => {
  const text = declarationText(source)
  const lines = source.split("\n")
  const lineAt = (index) => text.slice(0, index).split("\n").length
  const sites = []
  for (const match of text.matchAll(defaultImportPattern)) {
    const line = lineAt(match.index)
    sites.push({ line, kind: "import", text: lines[line - 1].trim() })
  }
  for (const match of text.matchAll(defaultExportPattern)) {
    const line = lineAt(match.index)
    sites.push({ line, kind: "export", text: lines[line - 1].trim() })
  }
  return sites.sort((a, b) => a.line - b.line)
}

const assertBuilt = async (packageRoot, manifest) => {
  const sourceRoot = join(packageRoot, "src")
  const esmOnly = esmOnlyModules(manifest)
  for (const source of await sourceFiles(sourceRoot)) {
    const modulePath = relative(sourceRoot, source).slice(0, -3)
    await Promise.all([
      access(join(packageRoot, "dist", "esm", `${modulePath}.js`)),
      access(join(packageRoot, "dist", "esm", `${modulePath}.d.ts`)),
      ...(esmOnly.has(modulePath) ? [] : [access(join(packageRoot, "dist", "cjs", `${modulePath}.js`))])
    ])
  }
}

const copyFilter = (packageRoot) => (source) => {
  const path = relative(packageRoot, source)
  if (path === "") return true
  const segments = path.split(sep)
  return !segments.some((segment) =>
    segment === "node_modules" ||
    segment === "coverage" ||
    segment === ".smithers"
  ) && !basename(path).endsWith(".tsbuildinfo")
}

const run = (command, args, options = {}) =>
  new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "inherit"],
      ...options
    })
    let stdout = ""
    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (chunk) => {
      stdout += chunk
    })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun(stdout)
      } else {
        reject(new Error(`${command} exited with ${code ?? signal ?? "unknown status"}`))
      }
    })
  })

const packWorkspace = async (name, outputDirectory, stagingRoot) => {
  const packageRoot = join(repoRoot, "packages", name)
  const manifestPath = join(packageRoot, "package.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  await assertBuilt(packageRoot, manifest)

  const stagedPackage = join(stagingRoot, name)
  await cp(packageRoot, stagedPackage, {
    recursive: true,
    filter: copyFilter(packageRoot)
  })
  await writeFile(
    join(stagedPackage, "package.json"),
    `${JSON.stringify(publicationManifest(manifest), null, 2)}\n`
  )

  const output = await run(
    "pnpm",
    [
      "--dir",
      stagedPackage,
      "pack",
      "--json",
      "--config.ignore-scripts=true",
      "--pack-destination",
      outputDirectory
    ]
  )
  const result = JSON.parse(output)
  return {
    name: manifest.name,
    version: manifest.version,
    filename: packResultFilename(result, manifest.name)
  }
}

export const main = async (args) => {
  const destination = args[0]
  if (destination === "--help") {
    console.log(
      [
        "usage: node scripts/pack-release.mjs <output-directory>",
        "       node scripts/pack-release.mjs --list    workspace directories, in publication order",
        "       node scripts/pack-release.mjs --names   package names, in publication order"
      ].join("\n")
    )
    return
  }
  if (destination === "--list") {
    console.log(workspaces.join("\n"))
    return
  }
  if (destination === "--names") {
    const manifests = readWorkspaceManifests()
    console.log(workspaces.map((directory) => manifests.get(directory).name).join("\n"))
    return
  }
  if (destination === undefined) {
    throw new Error("usage: node scripts/pack-release.mjs <output-directory> (or --list or --names)")
  }
  const outputDirectory = resolve(repoRoot, destination)
  await mkdir(outputDirectory, { recursive: true })
  // A pack directory is the whole release artifact, not an accumulator.
  // Leaving an earlier version's tarballs beside this one makes the directory
  // disagree with manifest.json, which is what scripts/smoke-release.mjs
  // checks before it trusts the set. CI packs into a fresh runner.temp, so the
  // stale files only ever appeared in a local `dist/release-packs`.
  for (const entry of await readdir(outputDirectory)) {
    if (entry.endsWith(".tgz") || entry === "manifest.json") {
      await rm(join(outputDirectory, entry), { force: true })
    }
  }
  const stagingRoot = await mkdtemp(join(tmpdir(), "smthrs-release-pack-"))
  try {
    const packed = []
    for (const name of workspaces) {
      packed.push(await packWorkspace(name, outputDirectory, stagingRoot))
    }
    await writeFile(
      join(outputDirectory, "manifest.json"),
      `${JSON.stringify(packed, null, 2)}\n`
    )
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
}

const isMain = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isMain) {
  await main(process.argv.slice(2))
}
